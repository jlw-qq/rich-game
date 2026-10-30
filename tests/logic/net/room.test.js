/**
 * 逻辑层：联网消息检查、限流、房间与座位。
 */
import { describe, it, expect } from 'vitest';
import { MAX_MESSAGE_BYTES, PROTOCOL_VERSION, ROOM_CODE_ALPHABET, parseClientMessage } from '../../../src/logic/net/protocol.js';
import { createRateLimiter } from '../../../src/logic/net/rateLimit.js';
import { createLobby } from '../../../src/logic/net/room.js';
import { decodeChallenge } from '../../../src/logic/systems/challenge.js';
import { validateState } from '../../../src/logic/core/stateValidator.js';
import { createBoard } from '../../../src/logic/core/board.js';
import { TILES, GROUPS } from '../../../src/data/config/board.js';
import { RULES } from '../../../src/data/config/rules.js';
import { CARDS } from '../../../src/data/config/cards.js';

const board = createBoard({ tiles: TILES, groups: GROUPS, rules: RULES });
const msg = (t, fields = {}) => JSON.stringify({ v: PROTOCOL_VERSION, t, ...fields });

describe('消息检查', () => {
  it('合法消息只保留认识的字段', () => {
    const r = parseClientMessage(JSON.stringify({ v: 1, t: 'join', code: 'ABCD', name: '小红', extra: { a: 1 } }));
    expect(r).toEqual({ ok: true, msg: { t: 'join', code: 'ABCD', name: '小红' } });
    expect(parseClientMessage(msg('start')).msg).toEqual({ t: 'start' });
  });

  it('坏消息给出原因，不抛异常', () => {
    expect(parseClientMessage(null).error).toContain('文本');
    expect(parseClientMessage('{').error).toContain('JSON');
    expect(parseClientMessage('[1]').error).toContain('格式');
    expect(parseClientMessage('null').error).toContain('格式');
    expect(parseClientMessage(JSON.stringify({ v: 2, t: 'start' })).error).toContain('版本');
    expect(parseClientMessage(JSON.stringify({ t: 'start' })).error).toContain('版本');
    expect(parseClientMessage(msg('hack')).error).toContain('未知消息');
    expect(parseClientMessage(msg('toString')).error).toContain('未知消息');
    expect(parseClientMessage(msg('create')).error).toContain('name');
    expect(parseClientMessage(msg('create', { name: 5 })).error).toContain('name');
    expect(parseClientMessage(msg('create', { name: 'x'.repeat(41) })).error).toContain('name');
    expect(parseClientMessage(msg('setSeat', { index: 1.5, kind: 'open' })).error).toContain('index');
    expect(parseClientMessage(msg('setSeat', { index: -1, kind: 'open' })).error).toContain('index');
    expect(parseClientMessage(msg('setSeat', { index: 1, kind: 'human' })).error).toContain('kind');
  });

  it('超长消息被拒绝（按 UTF-8 字节算）', () => {
    expect(parseClientMessage('x'.repeat(MAX_MESSAGE_BYTES + 1)).error).toContain('太长');
    expect(parseClientMessage('中'.repeat(Math.ceil(MAX_MESSAGE_BYTES / 3) + 1)).error).toContain('太长');
  });
});

describe('限流', () => {
  it('桶空后拒绝，按速度补充，不超过容量', () => {
    let t = 0;
    const limiter = createRateLimiter({ capacity: 3, perSecond: 2, now: () => t });
    expect([limiter.take(), limiter.take(), limiter.take(), limiter.take()]).toEqual([true, true, true, false]);
    t += 500;
    expect([limiter.take(), limiter.take()]).toEqual([true, false]);
    t += 60_000;
    expect([limiter.take(), limiter.take(), limiter.take(), limiter.take()]).toEqual([true, true, true, false]);
  });
});

/** 测试用房间服务：记下每个客户端收到的消息 */
function setup({ maxRooms } = {}) {
  const inbox = new Map();
  let n = 0;
  const lobby = createLobby({
    // 固定序列：房间码依次为 2222、3333……，种子固定
    randomInt: (max) => (max === 2 ** 32 ? 12345 : Math.floor(n / 4) % max),
    send: (id, m) => inbox.set(id, [...(inbox.get(id) ?? []), m]),
    maxRooms,
  });
  const handle = lobby.handle;
  const last = (id) => inbox.get(id)?.at(-1);
  const send = (id, t, fields) => {
    const parsed = parseClientMessage(msg(t, fields));
    if (!parsed.ok) throw new Error(parsed.error);
    handle(id, parsed.msg);
    if (t === 'create') n += 4;
    return last(id);
  };
  return { lobby, send, last, inbox };
}

describe('房间', () => {
  it('建房、加入、房主设置座位和模式，所有人看到同一个房间', () => {
    const { send, last } = setup();
    const room = send('a', 'create', { name: ' 小红 ' }).room;
    expect(room).toMatchObject({ phase: 'lobby', mode: 'quick', hostSeat: 0, you: 0 });
    expect(room.code).toMatch(new RegExp(`^[${ROOM_CODE_ALPHABET}]{4}$`));
    expect(room.seats.map((s) => s.kind)).toEqual(['human', 'open', 'closed', 'closed', 'closed']);
    expect(room.seats[0].name).toBe('小红');

    expect(send('b', 'join', { code: room.code.toLowerCase(), name: '小蓝' }).room).toMatchObject({ you: 1, hostSeat: 0 });
    send('a', 'setSeat', { index: 2, kind: 'normal' });
    send('a', 'setMode', { mode: 'classic' });
    expect(last('b').room).toMatchObject({ mode: 'classic' });
    expect(last('b').room.seats.map((s) => s.kind)).toEqual(['human', 'human', 'normal', 'closed', 'closed']);
    // 房间视图里没有其他人的连接 id
    expect(JSON.stringify(last('b'))).not.toContain('"a"');
  });

  it('加入失败的各种原因', () => {
    const { send } = setup();
    const { code } = send('a', 'create', { name: '小红' }).room;
    expect(send('b', 'join', { code: 'ZZZZ', name: '小蓝' }).message).toContain('找不到');
    expect(send('b', 'join', { code, name: '  ' }).message).toContain('名字');
    expect(send('b', 'join', { code, name: '一二三四五六七八九十一二三' }).message).toContain('12');
    expect(send('b', 'join', { code, name: '小红' }).message).toContain('换个名字');
    send('b', 'join', { code, name: '小蓝' });
    expect(send('c', 'join', { code, name: '小黄' }).message).toContain('已满');
    expect(send('b', 'join', { code, name: '小蓝' }).message).toContain('已经在房间');
    expect(send('b', 'create', { name: '小蓝' }).message).toContain('已经在房间');
  });

  it('只有房主能改设置；不能改有人的座位；未知模式被拒绝', () => {
    const { send } = setup();
    const { code } = send('a', 'create', { name: '小红' }).room;
    send('b', 'join', { code, name: '小蓝' });
    expect(send('b', 'setSeat', { index: 2, kind: 'normal' }).message).toContain('房主');
    expect(send('b', 'start').message).toContain('房主');
    expect(send('a', 'setSeat', { index: 1, kind: 'closed' }).message).toContain('已经有玩家');
    expect(send('a', 'setSeat', { index: 5, kind: 'open' }).message).toContain('不存在');
    expect(send('a', 'setMode', { mode: 'blitz' }).message).toContain('模式');
    expect(send('c', 'setMode', { mode: 'quick' }).message).toContain('不在房间');
    expect(send('c', 'leave').message).toContain('不在房间');
  });

  it('有空位或人数不足时不能开局', () => {
    const { send } = setup();
    send('a', 'create', { name: '小红' });
    expect(send('a', 'start').message).toContain('空位');
    send('a', 'setSeat', { index: 1, kind: 'closed' });
    expect(send('a', 'start').message).toContain('至少');
  });

  it('开局：去掉关闭的座位，AI 避开玩家的名字，每人知道自己的玩家 id，状态合法', () => {
    const { send, last, lobby } = setup();
    const { code } = send('a', 'create', { name: '小蓝' }).room;
    send('a', 'setSeat', { index: 1, kind: 'easy' });
    send('a', 'setSeat', { index: 3, kind: 'open' });
    send('b', 'join', { code, name: '阿明' });
    send('a', 'setSeat', { index: 4, kind: 'normal' });
    send('a', 'start');
    const started = last('a');
    expect(started).toMatchObject({ t: 'started', you: 'p1' });
    expect(last('b')).toMatchObject({ t: 'started', you: 'p3' });
    const { state } = started;
    expect(state.players.map((p) => p.name)).toEqual(['小蓝', '小红', '阿明', '小黄']);
    expect(state.players.map((p) => (p.isAI ? p.aiLevel : 'human'))).toEqual(['human', 'easy', 'human', 'normal']);
    expect(validateState(state, { board, rules: RULES, cards: CARDS })).toEqual([]);
    expect(decodeChallenge(state.challenge.code).config).toMatchObject({ mode: 'quick', seed: 12345 });
    expect(lobby.getRoom(code).phase).toBe('playing');
    // 开局后不能再加入或改设置
    expect(send('c', 'join', { code, name: '小紫' }).message).toContain('已经开始');
    expect(send('a', 'setMode', { mode: 'classic' }).message).toContain('已经开始');
    expect(send('a', 'start').message).toContain('已经开始');
  });

  it('离开：座位变回空位，房主交给下一位，没人了房间关闭', () => {
    const { send, last, lobby } = setup();
    const { code } = send('a', 'create', { name: '小红' }).room;
    send('a', 'setSeat', { index: 2, kind: 'open' });
    send('b', 'join', { code, name: '小蓝' });
    send('c', 'join', { code, name: '小黄' });
    expect(send('a', 'leave')).toEqual({ t: 'left' });
    expect(last('b').room).toMatchObject({ hostSeat: 1, you: 1 });
    expect(last('b').room.seats[0]).toEqual({ kind: 'open' });
    // 新房主可以改设置；原来的人能重新加入
    expect(send('b', 'setSeat', { index: 0, kind: 'normal' }).room.seats[0]).toEqual({ kind: 'normal' });
    lobby.disconnect('b');
    expect(last('c').room).toMatchObject({ hostSeat: 2 });
    lobby.disconnect('c');
    expect(lobby.roomCount()).toBe(0);
    expect(send('a', 'join', { code, name: '小红' }).message).toContain('找不到');
    lobby.disconnect('zzz'); // 不在房间里的连接断开不出错
  });

  it('对局中有人断开：其他人收到房间更新，所有玩家都走了房间关闭', () => {
    const { send, last, lobby } = setup();
    const { code } = send('a', 'create', { name: '小红' }).room;
    send('b', 'join', { code, name: '小蓝' });
    send('a', 'start');
    lobby.disconnect('a');
    expect(last('b').room.seats[0]).toEqual({ kind: 'gone' });
    expect(lobby.roomCount()).toBe(1);
    lobby.disconnect('b');
    expect(lobby.roomCount()).toBe(0);
  });

  it('房间数到上限时拒绝建房', () => {
    const { send, lobby } = setup({ maxRooms: 2 });
    send('a', 'create', { name: '甲' });
    send('b', 'create', { name: '乙' });
    expect(send('c', 'create', { name: '丙' }).message).toContain('已满');
    lobby.disconnect('a');
    expect(send('c', 'create', { name: '丙' }).t).toBe('room');
  });

  it('房间码撞车时换一个；一直撞车时报错而不是死循环', () => {
    const inbox = [];
    const lobby = createLobby({ randomInt: () => 0, send: (id, m) => inbox.push([id, m]) });
    lobby.handle('a', { t: 'create', name: '甲' });
    lobby.handle('b', { t: 'create', name: '乙' });
    expect(inbox.at(-1)).toEqual(['b', { t: 'error', message: expect.stringContaining('已满') }]);
    expect(lobby.roomCount()).toBe(1);
  });
});
