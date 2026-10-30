/**
 * 测试用：模拟服务器和多个客户端。所有消息都经过 JSON 往返，和真实连接一样。
 */
import { vi } from 'vitest';
import { PROTOCOL_VERSION, parseClientMessage } from '../../../src/logic/net/protocol.js';
import { createLobby } from '../../../src/logic/net/room.js';
import { createGame } from '../../../src/logic/core/game.js';
import { createEventBus } from '../../../src/logic/core/eventBus.js';
import { createBoard } from '../../../src/logic/core/board.js';
import { PHASES as P } from '../../../src/logic/core/turnMachine.js';
import { decideAction } from '../../../src/logic/ai/strategy.js';
import { createRng } from '../../../src/logic/utils/rng.js';
import { TILES, GROUPS } from '../../../src/data/config/board.js';
import { RULES } from '../../../src/data/config/rules.js';
import { CARDS } from '../../../src/data/config/cards.js';
import { rulesFor } from '../../../src/data/config/modes.js';

export const board = createBoard({ tiles: TILES, groups: GROUPS, rules: RULES });
export const OPTS = { aiDelayMs: 10, turnTimeoutMs: 1000, readyTimeoutMs: 500 };

/**
 * 模拟服务器和多个客户端。服务器发出的消息先排队，由 pump() 逐条送达，避免在广播中途重入。
 * disk 记录每个房间最新的存盘内容（JSON 往返过）；restoreFrom 传入上一台服务器的 disk 模拟重启。
 */
export function network({ seed = 4242, restoreFrom = null } = {}) {
  const queue = [];
  const clients = new Map();
  const disk = new Map();
  const kicked = [];
  let rooms = 0;
  let tokens = 0;
  const lobby = createLobby({
    randomInt: (max) => (max === 2 ** 32 ? seed : rooms % max),
    newToken: () => `tok${seed}-${++tokens}`,
    // 假哈希：倒序，便于检查存盘里没有令牌原文
    hashToken: (t) => `h:${[...t].reverse().join('')}`,
    send: (id, msg) => queue.push([id, JSON.parse(JSON.stringify(msg))]),
    kick: (id) => kicked.push(id),
    persist: (code, snap) => (snap === null ? disk.delete(code) : disk.set(code, JSON.parse(JSON.stringify(snap)))),
    matchOptions: OPTS,
  });
  const restoreErrors = [];
  for (const snap of restoreFrom?.values() ?? []) {
    const e = lobby.restore(snap);
    if (e) restoreErrors.push(e);
  }

  function client(id) {
    const c = { id, inbox: [], errors: [], state: null, you: null, seat: null, autoReady: true, autoPlay: false };
    c.send = (t, fields = {}) => {
      const parsed = parseClientMessage(JSON.stringify({ v: PROTOCOL_VERSION, t, ...fields }));
      if (!parsed.ok) throw new Error(parsed.error);
      lobby.handle(id, parsed.msg);
      if (t === 'create') rooms += 1;
      pump();
    };
    clients.set(id, c);
    return c;
  }

  function receive(c, msg) {
    c.inbox.push(msg);
    if (msg.t === 'error') c.errors.push(msg.message);
    if (msg.t === 'started') c.you = msg.you;
    if (msg.t === 'joined') c.seat = { code: msg.code, token: msg.token };
    if (msg.t !== 'update') return;
    // 和浏览器一样：原地替换副本
    if (c.state) {
      for (const k of Object.keys(c.state)) delete c.state[k];
      Object.assign(c.state, msg.state);
    } else c.state = msg.state;
    if (c.autoReady) c.send('ready', { seq: msg.seq });
    if (c.autoPlay) play(c);
  }

  /** 轮到自己时，用 AI 策略选一步发给服务器（走真实的 action 消息） */
  function play(c) {
    if (c.state.phase === P.GAME_OVER) return;
    const rules = rulesFor(c.state.mode, c.state.players.length);
    const game = createGame({ board, rules, state: structuredClone(c.state), bus: createEventBus(), cards: CARDS });
    if (game.actingPlayerId() !== c.you) return;
    const action = decideAction({ state: c.state, board, rules, cards: CARDS }, c.you, { level: 'normal', rng: createRng(c.state.turn) });
    if (action) c.send('action', { action });
  }

  function pump() {
    while (queue.length > 0) {
      const [id, msg] = queue.shift();
      const c = clients.get(id);
      if (c) receive(c, msg);
    }
  }

  /** 推进假时钟直到对局结束或步数用完 */
  function runToEnd(c, maxTimers = 20000) {
    for (let i = 0; i < maxTimers && c.state.phase !== P.GAME_OVER; i++) {
      vi.advanceTimersToNextTimer();
      pump();
    }
  }

  return { lobby, client, pump, runToEnd, disk, kicked, restoreErrors };
}

/** 建房：a 是房主，b 加入，其余座位按 extra 设置 */
export function room(net, extra = []) {
  const a = net.client('a');
  const b = net.client('b');
  a.send('create', { name: '小红' });
  const { code } = a.inbox.at(-1).room;
  b.send('join', { code, name: '小蓝' });
  extra.forEach((kind, i) => a.send('setSeat', { index: 2 + i, kind }));
  return { a, b, code };
}
