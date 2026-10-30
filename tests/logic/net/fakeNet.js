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
 *
 * latency：每条消息的单程延迟（毫秒）。给出时消息由假时钟送达，每条连接内保持先后顺序（和 TCP 一样），
 * 不同连接之间可以互相超车；可以按客户端设置（latencyOf）。连接断开后发给它的消息丢弃，
 * 断开本身在它之前发出的消息都到达服务器之后才生效。
 */
export function network({ seed = 4242, restoreFrom = null, latency = null, matchOptions = OPTS } = {}) {
  const queue = [];
  /** 每条连接上行、下行最后一条消息的到达时刻，保证同一连接内不乱序 */
  const lastUp = new Map();
  const lastDown = new Map();
  const latencyOf = new Map();
  const delay = (id) => (latencyOf.get(id) ?? latency)?.() ?? 0;
  const stats = { messages: 0, bytes: 0, maxBytes: 0, persists: 0 };

  /** 在连接 id 上排一条消息，返回送达前的等待时间 */
  function schedule(map, id, run) {
    const at = Math.max(map.get(id) ?? 0, Date.now() + delay(id));
    map.set(id, at);
    setTimeout(run, at - Date.now());
  }
  const clients = new Map();
  const disk = new Map();
  const kicked = [];
  let rooms = 0;
  let tokens = 0;
  let codeDraws = 0;
  const lobby = createLobby({
    // 房间码每次取不同的字符，开很多房间也不会一直撞车
    randomInt: (max) => (max === 2 ** 32 ? seed : (codeDraws++ * 7 + rooms) % max),
    newToken: () => `tok${seed}-${++tokens}`,
    // 假哈希：倒序，便于检查存盘里没有令牌原文
    hashToken: (t) => `h:${[...t].reverse().join('')}`,
    send(id, msg) {
      const text = JSON.stringify(msg);
      stats.messages += 1;
      stats.bytes += text.length;
      stats.maxBytes = Math.max(stats.maxBytes, text.length);
      if (!latency) return queue.push([id, JSON.parse(text)]);
      schedule(lastDown, id, () => {
        const c = clients.get(id);
        if (c && !c.closed) receive(c, JSON.parse(text));
      });
    },
    kick: (id) => {
      kicked.push(id);
      clients.get(id)?.drop();
    },
    persist: (code, snap) => {
      stats.persists += 1;
      if (snap === null) disk.delete(code);
      else disk.set(code, JSON.parse(JSON.stringify(snap)));
    },
    matchOptions,
  });
  const restoreErrors = [];
  for (const snap of restoreFrom?.values() ?? []) {
    const e = lobby.restore(snap);
    if (e) restoreErrors.push(e);
  }

  function client(id) {
    const c = { id, inbox: [], errors: [], state: null, you: null, seat: null, autoReady: true, autoPlay: false, closed: false };
    c.send = (t, fields = {}) => {
      if (c.closed) return;
      const parsed = parseClientMessage(JSON.stringify({ v: PROTOCOL_VERSION, t, ...fields }));
      if (!parsed.ok) throw new Error(parsed.error);
      const deliver = () => {
        lobby.handle(id, parsed.msg);
        if (t === 'create') rooms += 1;
      };
      if (latency || latencyOf.has(id)) schedule(lastUp, id, deliver);
      else {
        deliver();
        pump();
      }
    };
    /** 断开连接：之后的消息两头都不再送达 */
    c.drop = () => {
      if (c.closed) return;
      c.closed = true;
      if (latency || latencyOf.has(id)) schedule(lastUp, id, () => lobby.disconnect(id));
      else lobby.disconnect(id);
    };
    /** 单独设置这个客户端的延迟 */
    c.setLatency = (fn) => latencyOf.set(id, fn);
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

  return { lobby, client, pump, runToEnd, disk, kicked, restoreErrors, stats };
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
