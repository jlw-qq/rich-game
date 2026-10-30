/**
 * 逻辑层：断线重连与服务器重启后读回房间。
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { PHASES as P } from '../../../src/logic/core/turnMachine.js';
import { HOLD_MS, PAUSE_MS } from '../../../src/logic/net/room.js';
import { checksum } from '../../../src/data/save/saveFormat.js';
import { OPTS, network, room } from './fakeNet.js';

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

const updates = (c) => c.inbox.filter((m) => m.t === 'update');

describe('凭令牌重连', () => {
  it('加入时拿到令牌；房间视图和存盘里都没有令牌原文', () => {
    const net = network();
    const { a, b, code } = room(net);
    expect(a.seat).toEqual({ code, token: expect.any(String) });
    expect(b.seat.token).not.toBe(a.seat.token);
    // 令牌只发给本人
    expect(JSON.stringify(b.inbox)).not.toContain(a.seat.token);
    const disk = JSON.stringify(net.disk.get(code));
    expect(disk).not.toContain(a.seat.token);
    expect(disk).toContain(`h:${[...a.seat.token].reverse().join('')}`);
  });

  it('大厅里掉线：座位保留，期间凭令牌回到原座位；过期变回空位', () => {
    const net = network();
    const { a, b, code } = room(net);
    net.lobby.disconnect('b');
    net.pump();
    expect(a.inbox.at(-1).room.seats[1]).toEqual({ kind: 'human', name: '小蓝', online: false });
    // 掉线的人占着座位，不能开局
    a.send('setSeat', { index: 2, kind: 'closed' });
    a.send('start');
    expect(a.errors.at(-1)).toContain('小蓝 掉线了');

    vi.advanceTimersByTime(HOLD_MS - 1);
    const b2 = net.client('b2');
    b2.send('resume', b.seat);
    expect(b2.inbox.find((m) => m.t === 'room').room).toMatchObject({ you: 1 });
    expect(a.inbox.at(-1).room.seats[1].online).toBe(true);
    // 回来后旧的保留计时器不再生效
    vi.advanceTimersByTime(HOLD_MS * 2);
    expect(net.lobby.getRoom(code).seats[1].kind).toBe('human');

    net.lobby.disconnect('b2');
    vi.advanceTimersByTime(HOLD_MS);
    net.pump();
    expect(a.inbox.at(-1).room.seats[1]).toEqual({ kind: 'open' });
    const late = net.client('late');
    late.send('resume', b.seat);
    expect(late.inbox.at(-1)).toEqual({ t: 'resumeFailed', message: '你已经不在这个房间里了' });
  });

  it('错误令牌、别人的房间、关闭的房间、主动离开后的令牌都回不去', () => {
    const net = network();
    const { a, b, code } = room(net);
    const x = net.client('x');
    x.send('resume', { code, token: 'nope' });
    expect(x.inbox.at(-1).t).toBe('resumeFailed');
    x.send('resume', { code: 'ZZZZ', token: a.seat.token });
    expect(x.inbox.at(-1)).toMatchObject({ t: 'resumeFailed', message: '房间已经关闭了' });
    const bSeat = b.seat;
    b.send('leave');
    x.send('resume', bSeat);
    expect(x.inbox.at(-1).t).toBe('resumeFailed');
    // 已经在房间里的连接不能再 resume
    a.send('resume', a.seat);
    expect(a.errors.at(-1)).toContain('已经在房间里');
  });

  it('同一个令牌从新页面连上：旧页面被断开，新页面接管座位', () => {
    const net = network();
    const { a, b } = room(net);
    const b2 = net.client('b2');
    b2.send('resume', b.seat);
    expect(net.kicked).toEqual(['b']);
    // 旧连接之后断开不影响新连接的座位
    net.lobby.disconnect('b');
    net.pump();
    expect(a.inbox.at(-1).room.seats[1].online).toBe(true);
    b.send('setMode', { mode: 'classic' });
    expect(b.errors.at(-1)).toContain('不在房间');
  });

  it('对局中掉线由 AI 代打，回来后拿到当前局面并接着自己操作', () => {
    const net = network();
    const { a, b } = room(net, ['normal']);
    a.send('start');
    a.send('action', { action: { kind: 'roll' } });
    net.lobby.disconnect('b');
    net.pump();
    expect(updates(a).at(-1).notice).toContain('小蓝 掉线了');
    a.autoPlay = true;
    a.send('ready', { seq: updates(a).at(-1).seq });
    // 跑一会儿：小蓝的回合由 AI 代打，不用等 60 秒计时
    for (let i = 0; i < 400; i++) {
      vi.advanceTimersToNextTimer();
      net.pump();
    }
    expect(a.state.round).toBeGreaterThan(2);
    expect(updates(a).some((m) => m.notice?.includes('小蓝 超过'))).toBe(false);

    const b2 = net.client('b2');
    b2.send('resume', b.seat);
    expect(b2.you).toBe('p2');
    const first = updates(b2)[0];
    expect(first.notice).toContain('小蓝 重新连上了');
    expect(b2.state).toEqual(a.state);
    // 回来后轮到小蓝时等他自己操作（超时才代走）
    b2.autoPlay = true;
    net.runToEnd(a);
    expect(a.state.phase).toBe(P.GAME_OVER);
    expect(b2.state).toEqual(a.state);
  });

  it('对局中所有人都掉线：暂停，AI 不走；有人回来继续；一直没人回来就关闭房间', () => {
    const net = network();
    const { a, b, code } = room(net, ['normal']);
    a.send('start');
    net.lobby.disconnect('a');
    net.lobby.disconnect('b');
    const match = net.lobby.getRoom(code).match;
    const seq = match.seq;
    vi.advanceTimersByTime(PAUSE_MS - 1);
    expect(match.seq).toBe(seq);
    expect(match.waiting).toBe(false);

    const a2 = net.client('a2');
    a2.send('resume', a.seat);
    a2.autoPlay = true;
    vi.advanceTimersByTime(PAUSE_MS);
    expect(net.lobby.roomCount()).toBe(1);
    expect(match.seq).toBeGreaterThan(seq + 1);

    net.lobby.disconnect('a2');
    vi.advanceTimersByTime(PAUSE_MS);
    expect(net.lobby.roomCount()).toBe(0);
    expect(net.disk.size).toBe(0);
  });
});

describe('服务器重启后读回房间', () => {
  /** 打几步后“重启”：用旧服务器的存盘建一台新服务器 */
  function playThenRestart() {
    const net = network({ seed: 7 });
    const { a, b, code } = room(net, ['easy']);
    a.autoPlay = true;
    b.autoPlay = true;
    a.send('start');
    for (let i = 0; i < 60; i++) {
      vi.advanceTimersToNextTimer();
      net.pump();
    }
    const before = structuredClone(net.lobby.getRoom(code).match.state);
    const seq = net.lobby.getRoom(code).match.seq;
    net.lobby.getRoom(code).match.dispose();
    const net2 = network({ seed: 7, restoreFrom: net.disk });
    return { net, net2, a, b, code, before, seq };
  }

  it('对局完全一样，所有人算掉线，对局暂停；凭令牌回来后接着打完', () => {
    const { net2, a, b, code, before, seq } = playThenRestart();
    expect(net2.restoreErrors).toEqual([]);
    const restored = net2.lobby.getRoom(code);
    expect(restored.match.state).toEqual(before);
    expect(restored.match.seq).toBe(seq);
    expect(restored.match.waiting).toBe(false);

    const a2 = net2.client('a2');
    const b2 = net2.client('b2');
    a2.autoPlay = true;
    b2.autoPlay = true;
    a2.send('resume', a.seat);
    b2.send('resume', b.seat);
    expect(a2.you).toBe('p1');
    expect(b2.you).toBe('p2');
    // 批次接着编号，客户端不会把新批次当成旧的
    expect(updates(a2)[0].seq).toBeGreaterThan(seq);
    expect(a2.state).toMatchObject({ turn: before.turn, round: before.round });
    net2.runToEnd(a2);
    expect(a2.state.phase).toBe(P.GAME_OVER);
    expect(b2.state).toEqual(a2.state);
  });

  it('重启后一直没人回来：到时间关闭并删掉存盘', () => {
    const { net2, code } = playThenRestart();
    expect(net2.lobby.roomCount()).toBe(1);
    vi.advanceTimersByTime(PAUSE_MS);
    expect(net2.lobby.roomCount()).toBe(0);
    expect(net2.disk.has(code)).toBe(false);
  });

  it('大厅里的房间读回后座位保留，过期让出', () => {
    const net = network();
    const { a, code } = room(net);
    const net2 = network({ restoreFrom: net.disk });
    expect(net2.restoreErrors).toEqual([]);
    const a2 = net2.client('a2');
    a2.send('resume', a.seat);
    expect(a2.inbox.find((m) => m.t === 'room').room).toMatchObject({ code, you: 0, hostSeat: 0 });
    vi.advanceTimersByTime(HOLD_MS);
    net2.pump();
    // 小蓝没回来：座位变回空位，房间还在
    expect(a2.inbox.at(-1).room.seats[1]).toEqual({ kind: 'open' });
  });

  it('损坏或被改过的存盘被拒绝，不影响其他房间', () => {
    const { net } = playThenRestart();
    const good = [...net.disk.values()][0];
    const bad = (mut) => {
      const s = structuredClone(good);
      mut(s);
      return s;
    };
    const cases = [
      [null, '版本'],
      [bad((s) => (s.v = 99)), '版本'],
      [bad((s) => (s.code = '../x')), '房间码'],
      [bad((s) => (s.mode = 'blitz')), '模式'],
      [bad((s) => (s.phase = 'weird')), '阶段'],
      [bad((s) => s.seats.pop()), '座位'],
      [bad((s) => (s.seats[0].kind = 'god')), '座位'],
      [bad((s) => (s.seats[0].name = '  ')), '名字'],
      [bad((s) => (s.seats[0].tokenHash = '')), '令牌'],
      [bad((s) => (s.seats[1].tokenHash = s.seats[0].tokenHash)), '令牌重复'],
      [bad((s) => (s.hostSeat = 2)), '房主'],
      [bad((s) => (s.save = s.save.replace('"cash":', '"cash":1'))), '对局存档无效'],
      [bad((s) => (s.seats[0].playerId = 'p3')), '对不上'],
      [bad((s) => (s.seq = -1)), '序号'],
      [
        bad((s) => {
          // 校验和对得上、但内容不合规则：现金为负
          const save = JSON.parse(s.save);
          save.state.players[0].cash = -5;
          save.checksum = checksum(JSON.stringify(save.state));
          s.save = JSON.stringify(save);
        }),
        '对局存档无效',
      ],
    ];
    const net2 = network({ restoreFrom: new Map(cases.map(([snap], i) => [`k${i}`, snap])) });
    expect(net2.restoreErrors.length).toBe(cases.length);
    cases.forEach(([, word], i) => expect(net2.restoreErrors[i], `case ${i}`).toContain(word));
    expect(net2.lobby.roomCount()).toBe(0);
    // 好的存盘照常读回
    const net3 = network({ restoreFrom: new Map([['g', good], ['dup', good]]) });
    expect(net3.lobby.roomCount()).toBe(1);
    expect(net3.restoreErrors).toEqual(['房间码重复']);
  });
});

describe('时间常量', () => {
  it('测试用的对局节奏比保留时间短', () => {
    expect(OPTS.turnTimeoutMs).toBeLessThan(HOLD_MS);
  });
});
