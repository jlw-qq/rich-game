/**
 * 逻辑层：服务器上的联网对局。
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { PROTOCOL_VERSION, parseClientMessage } from '../../../src/logic/net/protocol.js';
import { PHASES as P } from '../../../src/logic/core/turnMachine.js';
import { validateState } from '../../../src/logic/core/stateValidator.js';
import { RULES } from '../../../src/data/config/rules.js';
import { CARDS } from '../../../src/data/config/cards.js';
import { OPTS, board, network, room } from './fakeNet.js';

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

describe('联网对局', () => {
  it('只能在轮到自己时操作；不合规的操作被拒绝，对局不变', () => {
    const net = network();
    const { a, b } = room(net);
    a.send('start');
    expect(a.you).toBe('p1');
    expect(b.you).toBe('p2');
    const before = JSON.stringify(a.state);

    b.send('action', { action: { kind: 'roll' } });
    expect(b.errors.at(-1)).toContain('还没轮到你');
    a.send('action', { action: { kind: 'buy' } });
    expect(a.errors.at(-1)).toBeTruthy();
    a.send('action', { action: { kind: 'upgrade', tileId: '__proto__' } });
    a.send('action', { action: { kind: 'proposeTrade', trade: { toId: 'p2', give: { properties: ['nope'], cash: -5 } } } });
    a.send('action', { action: { kind: 'proposeTrade', trade: { toId: 'p1', give: { cash: 1 } } } });
    a.send('action', { action: { kind: 'choose', index: 3 } });
    expect(a.errors.length).toBe(5);
    expect(JSON.stringify(a.state)).toBe(before);
    // 被拒绝的操作不会广播
    expect(b.inbox.filter((m) => m.t === 'update').length).toBe(1);

    a.send('action', { action: { kind: 'roll' } });
    const update = b.inbox.at(-1);
    expect(update).toMatchObject({ t: 'update', seq: 2 });
    expect(update.events.map(([type]) => type)).toContain('diceRolled');
    expect(b.state).toEqual(a.state);
  });

  it('交易：只有被问的一方能答复', () => {
    const net = network();
    const { a, b } = room(net);
    a.send('start');
    const mine = Object.entries(a.state.properties).find(([, p]) => p.ownerId === 'p1')?.[0];
    a.send('action', { action: { kind: 'proposeTrade', trade: { toId: 'p2', give: { cash: 100 }, take: {} } } });
    expect(a.state.phase).toBe(P.AWAIT_TRADE);
    a.send('action', { action: { kind: 'acceptTrade' } });
    expect(a.errors.at(-1)).toContain('还没轮到你');
    b.send('action', { action: { kind: 'acceptTrade' } });
    expect(b.state.phase).toBe(P.AWAIT_ROLL);
    expect(b.state.players[1].cash - a.state.players[0].cash).toBe(200);
    expect(mine).toBeTruthy();
  });

  it('等所有人播完动画（或等待超时）后 AI 才走下一步', () => {
    const net = network();
    const { a, b } = room(net, ['normal']);
    a.send('start');
    // 让 p1、p2 先结束回合，轮到 AI
    for (const c of [a, b]) {
      c.send('action', { action: { kind: 'roll' } });
      while (c.state.phase !== P.AWAIT_ROLL || c.state.players[c.state.currentPlayerIndex].id === c.you) {
        const r = c.state.phase === P.TURN_END ? 'endTurn' : c.state.phase === P.AWAIT_DECISION ? 'decline' : c.state.phase === P.AWAIT_CHOICE ? 'choose' : c.state.phase === P.AWAIT_ROLL ? 'roll' : 'payDebt';
        c.send('action', { action: r === 'choose' ? { kind: 'choose', index: 0 } : { kind: r } });
        if (c.state.phase === P.GAME_OVER) return;
      }
    }
    expect(a.state.players[a.state.currentPlayerIndex].isAI).toBe(true);
    const seq = a.inbox.filter((m) => m.t === 'update').length;

    // b 暂停回 ready：AI 不动
    b.autoReady = false;
    a.send('ready', { seq: a.inbox.at(-1).seq });
    vi.advanceTimersByTime(OPTS.aiDelayMs * 5);
    net.pump();
    // 自动 ready 已经回过一次，再触发一次无效 ready 也不出错
    b.send('ready', { seq: 999 });
    // 只有 a ready 时等待超时前 AI 不会走
    const countNow = a.inbox.filter((m) => m.t === 'update').length;
    expect(countNow).toBeLessThanOrEqual(seq + 1);
    vi.advanceTimersByTime(OPTS.readyTimeoutMs + OPTS.aiDelayMs * 2);
    net.pump();
    expect(a.inbox.filter((m) => m.t === 'update').length).toBeGreaterThan(countNow);
  });

  it('人类玩家超时由 AI 代走一步，并通知所有人', () => {
    const net = network();
    const { a, b } = room(net);
    a.send('start');
    vi.advanceTimersByTime(OPTS.turnTimeoutMs - 1);
    net.pump();
    expect(a.state.turn).toBe(1);
    expect(a.inbox.filter((m) => m.t === 'update').length).toBe(1);
    vi.advanceTimersByTime(1);
    net.pump();
    const update = b.inbox.at(-1);
    expect(update.notice).toContain('小红 超过 1 秒没有操作');
    expect(update.events.map(([t]) => t)).toContain('diceRolled');
    // 代走只走一步：玩家仍是人类，之后还能自己操作
    expect(b.state.players[0].isAI).toBe(false);
  });

  it('离开的玩家一直由 AI 代打，对局能打完；全部掉线后暂停，到时间房间关闭', () => {
    const net = network();
    const { a, b } = room(net, ['easy']);
    a.send('start');
    b.send('leave');
    net.pump();
    expect(a.inbox.find((m) => m.t === 'room' && m.room.seats[1].kind === 'gone')).toBeTruthy();
    a.autoPlay = true;
    net.pump();
    a.send('ready', { seq: a.inbox.filter((m) => m.t === 'update').at(-1).seq });
    net.runToEnd(a);
    expect(a.state.phase).toBe(P.GAME_OVER);
    expect(validateState(a.state, { board, rules: RULES, cards: CARDS })).toEqual([]);
    // 掉线的人再发消息无效
    expect(b.inbox.filter((m) => m.t === 'update').length).toBeLessThan(a.inbox.filter((m) => m.t === 'update').length);
    net.lobby.disconnect('a');
    expect(net.lobby.roomCount()).toBe(1);
    vi.advanceTimersByTime(10 * 60_000);
    expect(net.lobby.roomCount()).toBe(0);
    // 房间关闭后定时器都清掉了，时间再走也不会出错
    vi.advanceTimersByTime(60_000);
  });

  it('2 位人类 + 2 个 AI 打完整局：每个客户端看到的状态和服务器一致，AI 没有兜底', () => {
    for (const seed of [1, 2, 3]) {
      const net = network({ seed });
      const { a, b, code } = room(net, ['normal', 'easy']);
      a.autoPlay = true;
      b.autoPlay = true;
      a.send('start');
      net.runToEnd(a);
      const match = net.lobby.getRoom(code).match;
      expect(a.state.phase, `seed ${seed}`).toBe(P.GAME_OVER);
      expect(a.state).toEqual(match.state);
      expect(b.state).toEqual(match.state);
      expect(match.stats.fallbacks).toBe(0);
      // 序号连续，没有漏掉的批次
      const seqs = b.inbox.filter((m) => m.t === 'update').map((m) => m.seq);
      expect(seqs).toEqual(seqs.map((_, i) => i + 1));
      expect(a.errors).toEqual([]);
      expect(b.errors).toEqual([]);
      // 人类玩家都是自己操作的，没有触发超时代打
      expect(b.inbox.filter((m) => m.notice)).toEqual([]);
      expect(a.state.round).toBeGreaterThan(1);
    }
  });

  it('结束后房主带大家回房间，可以再开一局；未结束时不行', () => {
    const net = network();
    const { a, b, code } = room(net, ['normal']);
    a.send('start');
    a.send('toLobby');
    expect(a.errors.at(-1)).toContain('还没结束');
    a.autoPlay = true;
    b.autoPlay = true;
    net.pump();
    a.send('ready', { seq: a.inbox.filter((m) => m.t === 'update').at(-1).seq });
    play: for (let i = 0; i < 20000; i++) {
      if (a.state.phase === P.GAME_OVER) break play;
      vi.advanceTimersToNextTimer();
      net.pump();
    }
    expect(a.state.phase).toBe(P.GAME_OVER);
    b.send('toLobby');
    expect(b.errors.at(-1)).toContain('房主');
    a.send('toLobby');
    expect(b.inbox.at(-1)).toMatchObject({ t: 'room', room: { phase: 'lobby', code } });
    expect(net.lobby.getRoom(code).match).toBeNull();
    a.autoPlay = false;
    b.autoPlay = false;
    a.send('start');
    expect(a.inbox.at(-1)).toMatchObject({ t: 'update', seq: 1 });
    expect(a.state.turn).toBe(1);
  });

  it('不在对局中发对局消息被拒绝', () => {
    const net = network();
    const c = net.client('z');
    c.send('action', { action: { kind: 'roll' } });
    expect(c.errors.at(-1)).toContain('不在对局');
    c.send('ready', { seq: 1 });
    c.send('toLobby');
    expect(c.errors.at(-1)).toContain('不在对局');
  });
});

describe('对局消息检查', () => {
  const parse = (action) => parseClientMessage(JSON.stringify({ v: PROTOCOL_VERSION, t: 'action', action }));

  it('只保留认识的字段', () => {
    expect(parse({ kind: 'upgrade', tileId: 't1', evil: 1 }).msg).toEqual({ t: 'action', action: { kind: 'upgrade', tileId: 't1' } });
    expect(parse({ kind: 'proposeTrade', trade: { toId: 'p2', give: {}, take: {}, fromId: 'p3' } }).msg.action.trade).toEqual({ toId: 'p2', give: {}, take: {} });
  });

  it('坏操作被拒绝', () => {
    for (const bad of [null, [], 'roll', { kind: 'hack' }, { kind: 'roll', tileId: 5 }, { kind: 'choose', index: -1 }, { kind: 'choose', index: 1.5 }, { kind: 'proposeTrade', trade: [] }]) {
      expect(parse(bad).ok, JSON.stringify(bad)).toBe(false);
    }
  });
});
