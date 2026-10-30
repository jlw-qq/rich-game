/**
 * 逻辑层：联网房间。只管房间和座位，不碰网络：服务器把收到的消息交给 handle，
 * 要发出去的消息通过 send 回调交给服务器。随机数由调用方注入（服务器用 crypto），便于测试。
 *
 * 座位固定 5 个（等于最大人数）：human 玩家 / open 空位 / closed 关闭 / normal、easy AI。
 * 开局时去掉关闭的座位，其余按座位顺序成为 p1、p2……；有空位时不能开局。
 * 对局交给 match.js 在服务器上运行。对局中有人断开时座位标为 gone，由 AI 代打到结束。
 * 对局结束后房主可以带大家回到房间（gone 的座位变回空位），再开一局。
 */
import { MAX_NAME_LENGTH, createInitialState } from '../core/gameState.js';
import { createBoard } from '../core/board.js';
import { encodeChallenge, seatKinds } from '../systems/challenge.js';
import { ROOM_CODE_ALPHABET, ROOM_CODE_LENGTH, normalizeRoomCode } from './protocol.js';
import { createMatch } from './match.js';
import { PHASES } from '../core/turnMachine.js';
import { TILES, GROUPS } from '../../data/config/board.js';
import { RULES } from '../../data/config/rules.js';
import { CARDS } from '../../data/config/cards.js';
import { DEFAULT_MODE, MODES, rulesFor } from '../../data/config/modes.js';
import { SEAT_NAMES } from '../../data/config/challenge.js';

/** 一台服务器同时最多开的房间数 */
export const MAX_ROOMS = 100;
const SEAT_COUNT = RULES.maxPlayers;

const board = createBoard({ tiles: TILES, groups: GROUPS, rules: RULES });

/**
 * @param {{
 *   randomInt: (max: number) => number,
 *   send: (clientId: string, msg: object) => void,
 *   maxRooms?: number,
 *   matchOptions?: { aiDelayMs?: number, turnTimeoutMs?: number, readyTimeoutMs?: number },
 * }} options randomInt 返回 [0, max) 的整数；matchOptions 传给 createMatch（测试时缩短等待）
 */
export function createLobby({ randomInt, send, maxRooms = MAX_ROOMS, matchOptions = {} }) {
  /** @type {Map<string, object>} 房间码 → 房间 */
  const rooms = new Map();
  /** @type {Map<string, string>} 客户端 → 所在房间码 */
  const roomOf = new Map();

  const error = (clientId, message) => send(clientId, { t: 'error', message });
  const humans = (room) => room.seats.filter((s) => s.kind === 'human');

  /** 发给某位玩家看的房间情况 */
  function roomView(room, clientId) {
    return {
      code: room.code,
      mode: room.mode,
      phase: room.phase,
      hostSeat: room.seats.findIndex((s) => s.clientId === room.hostId),
      you: room.seats.findIndex((s) => s.clientId === clientId),
      seats: room.seats.map((s) => (s.kind === 'human' ? { kind: 'human', name: s.name } : { kind: s.kind })),
    };
  }

  function broadcast(room) {
    for (const s of humans(room)) send(s.clientId, { t: 'room', room: roomView(room, s.clientId) });
  }

  /** 名字的检查与开局一致：去掉首尾空白后不能为空、不能太长 */
  function checkName(name) {
    const trimmed = name.trim();
    if (trimmed === '') return { error: '请输入名字' };
    if ([...trimmed].length > MAX_NAME_LENGTH) return { error: `名字不能超过 ${MAX_NAME_LENGTH} 个字` };
    return { name: trimmed };
  }

  function newCode() {
    for (let attempt = 0; attempt < 50; attempt++) {
      const code = Array.from({ length: ROOM_CODE_LENGTH }, () => ROOM_CODE_ALPHABET[randomInt(ROOM_CODE_ALPHABET.length)]).join('');
      if (!rooms.has(code)) return code;
    }
    return null;
  }

  function create(clientId, msg) {
    const n = checkName(msg.name);
    if (n.error) return error(clientId, n.error);
    if (rooms.size >= maxRooms) return error(clientId, '服务器房间已满，请稍后再试');
    const code = newCode();
    if (!code) return error(clientId, '服务器房间已满，请稍后再试');
    const seats = Array.from({ length: SEAT_COUNT }, (_, i) => ({ kind: i === 1 ? 'open' : 'closed' }));
    seats[0] = { kind: 'human', clientId, name: n.name };
    const room = { code, mode: DEFAULT_MODE, phase: 'lobby', hostId: clientId, seats, match: null, playerIds: null };
    rooms.set(code, room);
    roomOf.set(clientId, code);
    broadcast(room);
  }

  function join(clientId, msg) {
    const n = checkName(msg.name);
    if (n.error) return error(clientId, n.error);
    const room = rooms.get(normalizeRoomCode(msg.code));
    if (!room) return error(clientId, '找不到这个房间，请检查房间码');
    if (room.phase !== 'lobby') return error(clientId, '这个房间的对局已经开始了');
    if (humans(room).some((s) => s.name === n.name)) return error(clientId, `房间里已经有人叫「${n.name}」了，换个名字吧`);
    const index = room.seats.findIndex((s) => s.kind === 'open');
    if (index < 0) return error(clientId, '房间已满');
    room.seats[index] = { kind: 'human', clientId, name: n.name };
    roomOf.set(clientId, room.code);
    broadcast(room);
  }

  /** 离开房间：大厅里座位变回空位；房主走了交给下一位玩家；没人了就关掉房间 */
  function leave(clientId) {
    const room = rooms.get(roomOf.get(clientId));
    roomOf.delete(clientId);
    if (!room) return;
    const index = room.seats.findIndex((s) => s.clientId === clientId);
    room.seats[index] = { kind: room.phase === 'lobby' ? 'open' : 'gone' };
    if (room.phase === 'playing') {
      room.match.leave(room.playerIds.get(clientId));
      room.playerIds.delete(clientId);
    }
    if (humans(room).length === 0) {
      room.match?.dispose();
      rooms.delete(room.code);
      return;
    }
    if (room.hostId === clientId) room.hostId = humans(room)[0].clientId;
    broadcast(room);
  }

  /** 房主在大厅里才能做的操作 */
  function hostRoom(clientId) {
    const room = rooms.get(roomOf.get(clientId));
    if (!room) return { error: '你不在房间里' };
    if (room.hostId !== clientId) return { error: '只有房主可以修改设置' };
    if (room.phase !== 'lobby') return { error: '对局已经开始了' };
    return { room };
  }

  function setMode(clientId, msg) {
    const { room, error: e } = hostRoom(clientId);
    if (e) return error(clientId, e);
    if (!Object.hasOwn(MODES, msg.mode)) return error(clientId, `未知对局模式: ${msg.mode}`);
    room.mode = msg.mode;
    broadcast(room);
  }

  function setSeat(clientId, msg) {
    const { room, error: e } = hostRoom(clientId);
    if (e) return error(clientId, e);
    if (msg.index >= SEAT_COUNT) return error(clientId, '座位不存在');
    if (room.seats[msg.index].kind === 'human') return error(clientId, '这个座位已经有玩家了');
    room.seats[msg.index] = { kind: msg.kind };
    broadcast(room);
  }

  function start(clientId) {
    const { room, error: e } = hostRoom(clientId);
    if (e) return error(clientId, e);
    if (room.seats.some((s) => s.kind === 'open')) return error(clientId, '还有空位：等人加入，或把空位改成 AI 或关闭');
    const seated = room.seats.filter((s) => s.kind !== 'closed');
    if (seated.length < RULES.minPlayers) return error(clientId, `至少要 ${RULES.minPlayers} 位玩家`);

    // AI 按座位取名，避开玩家已经用了的名字。名字表和座位一样多，一定够用
    const taken = new Set(humans(room).map((s) => s.name));
    const spare = SEAT_NAMES.filter((n) => !taken.has(n));
    const players = seated.map((s) => (s.kind === 'human' ? { name: s.name, isAI: false } : { name: spare.shift(), isAI: true, aiLevel: s.kind }));
    const seed = randomInt(2 ** 32);
    const rules = rulesFor(room.mode, players.length);
    const challenge = { code: encodeChallenge({ mode: room.mode, kinds: seatKinds(players), seed }), daily: null };
    const state = createInitialState({ board, rules, cards: CARDS, players, seed, mode: room.mode, challenge });
    room.phase = 'playing';
    /** 客户端 → 玩家 id */
    room.playerIds = new Map(seated.flatMap((s, i) => (s.kind === 'human' ? [[s.clientId, state.players[i].id]] : [])));
    room.match = createMatch({
      ...matchOptions,
      state,
      humans: [...room.playerIds.values()],
      broadcast: (msg) => {
        for (const id of room.playerIds.keys()) send(id, msg);
      },
    });
    broadcast(room);
    for (const [id, playerId] of room.playerIds) send(id, { t: 'started', you: playerId });
    room.match.begin();
  }

  /** 对局中的房间和这位玩家的 id */
  function playing(clientId) {
    const room = rooms.get(roomOf.get(clientId));
    if (!room || room.phase !== 'playing') return { error: '你不在对局中' };
    return { room, playerId: room.playerIds.get(clientId) };
  }

  function action(clientId, msg) {
    const { room, playerId, error: e } = playing(clientId);
    if (e) return error(clientId, e);
    const r = room.match.act(playerId, msg.action);
    if (!r.ok) error(clientId, r.error);
  }

  function ready(clientId, msg) {
    const { room, playerId } = playing(clientId);
    room?.match.ready(playerId, msg.seq);
  }

  /** 对局结束后回到房间：离开的人的座位变回空位，设置保留 */
  function toLobby(clientId) {
    const room = rooms.get(roomOf.get(clientId));
    if (!room || room.phase !== 'playing') return error(clientId, '你不在对局中');
    if (room.hostId !== clientId) return error(clientId, '只有房主可以带大家回房间');
    if (room.match.state.phase !== PHASES.GAME_OVER) return error(clientId, '对局还没结束');
    room.match.dispose();
    room.match = null;
    room.playerIds = null;
    room.phase = 'lobby';
    room.seats = room.seats.map((s) => (s.kind === 'gone' ? { kind: 'open' } : s));
    broadcast(room);
  }

  const HANDLERS = { create, join, setMode, setSeat, start, action, ready, toLobby };

  return {
    /**
     * 处理一条已通过 parseClientMessage 检查的消息。
     * @param {string} clientId
     * @param {{ t: string } & Record<string, unknown>} msg
     */
    handle(clientId, msg) {
      if (msg.t === 'leave') {
        if (!roomOf.has(clientId)) return error(clientId, '你不在房间里');
        leave(clientId);
        return send(clientId, { t: 'left' });
      }
      if ((msg.t === 'create' || msg.t === 'join') && roomOf.has(clientId)) return error(clientId, '你已经在房间里了');
      HANDLERS[msg.t](clientId, msg);
    },
    /** 连接断开 */
    disconnect(clientId) {
      if (roomOf.has(clientId)) leave(clientId);
    },
    roomCount: () => rooms.size,
    /** 测试用：查看房间内部数据 */
    getRoom: (code) => rooms.get(code),
  };
}
