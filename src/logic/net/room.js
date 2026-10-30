/**
 * 逻辑层：联网房间。只管房间和座位，不碰网络和磁盘：服务器把收到的消息交给 handle，
 * 要发出去的消息通过 send 回调交给服务器，要存盘的房间通过 persist 回调交出去。
 * 随机数、令牌和哈希由调用方注入（服务器用 crypto），便于测试。
 *
 * 座位固定 5 个（等于最大人数）：human 玩家 / open 空位 / closed 关闭 / normal、easy AI / gone 已离开对局。
 * 开局时去掉关闭的座位，其余按座位顺序成为 p1、p2……；有空位时不能开局。对局交给 match.js 在服务器上运行。
 *
 * 断线重连：加入房间时每个座位拿到一个随机令牌，房间里只存它的哈希。掉线不等于离开：
 * - 大厅里座位保留 holdMs，期间凭令牌（resume）回到原座位，过期变回空位；
 * - 对局中掉线由 AI 代打，回来后接着自己操作，座位一直保留到对局结束；
 * - 所有人都不在线时对局暂停，pauseMs 内没人回来就关闭房间；
 * - 主动离开（leave）才真正让出座位，令牌随之作废。
 */
import { MAX_NAME_LENGTH, createInitialState } from '../core/gameState.js';
import { createBoard } from '../core/board.js';
import { importSave } from '../core/saveGame.js';
import { encodeChallenge, seatKinds } from '../systems/challenge.js';
import { ROOM_CODE_ALPHABET, ROOM_CODE_LENGTH, normalizeRoomCode } from './protocol.js';
import { createMatch } from './match.js';
import { PHASES } from '../core/turnMachine.js';
import { TILES, GROUPS } from '../../data/config/board.js';
import { RULES } from '../../data/config/rules.js';
import { CARDS } from '../../data/config/cards.js';
import { DEFAULT_MODE, MODES, rulesFor } from '../../data/config/modes.js';
import { SEAT_NAMES } from '../../data/config/challenge.js';
import { serializeSave } from '../../data/save/saveFormat.js';

/** 一台服务器同时最多开的房间数 */
export const MAX_ROOMS = 100;
/** 大厅里掉线后座位保留多久 */
export const HOLD_MS = 60_000;
/** 所有人都掉线后对局保留多久 */
export const PAUSE_MS = 10 * 60_000;
export const SNAPSHOT_VERSION = 1;
const SEAT_COUNT = RULES.maxPlayers;
const SEAT_KINDS = ['human', 'open', 'closed', 'normal', 'easy', 'gone'];

const board = createBoard({ tiles: TILES, groups: GROUPS, rules: RULES });
const saveCtx = { board, rules: RULES, cards: CARDS };

/**
 * @param {{
 *   randomInt: (max: number) => number,
 *   newToken: () => string,
 *   hashToken: (token: string) => string,
 *   send: (clientId: string, msg: object) => void,
 *   kick?: (clientId: string) => void,
 *   persist?: (code: string, snapshot: object | null) => void,
 *   maxRooms?: number,
 *   holdMs?: number,
 *   pauseMs?: number,
 *   matchOptions?: { aiDelayMs?: number, turnTimeoutMs?: number, readyTimeoutMs?: number },
 * }} options randomInt 返回 [0, max) 的整数；kick 断开被新页面顶替的旧连接；
 *   persist 在房间变化后调用，snapshot 为 null 表示房间已关闭；matchOptions 传给 createMatch（测试时缩短等待）
 */
export function createLobby({
  randomInt,
  newToken,
  hashToken,
  send,
  kick = () => {},
  persist = () => {},
  maxRooms = MAX_ROOMS,
  holdMs = HOLD_MS,
  pauseMs = PAUSE_MS,
  matchOptions = {},
}) {
  /** @type {Map<string, object>} 房间码 → 房间 */
  const rooms = new Map();
  /** @type {Map<string, string>} 客户端 → 所在房间码 */
  const roomOf = new Map();

  const error = (clientId, message) => send(clientId, { t: 'error', message });
  const humans = (room) => room.seats.filter((s) => s.kind === 'human');
  const seatOf = (room, clientId) => room.seats.findIndex((s) => s.kind === 'human' && s.clientId === clientId);
  const roomFor = (clientId) => rooms.get(roomOf.get(clientId));

  /** 发给某位玩家看的房间情况。令牌、连接 id 都不发出去 */
  function roomView(room, clientId) {
    return {
      code: room.code,
      mode: room.mode,
      phase: room.phase,
      hostSeat: room.hostSeat,
      you: seatOf(room, clientId),
      seats: room.seats.map((s) => (s.kind === 'human' ? { kind: 'human', name: s.name, online: s.clientId !== null } : { kind: s.kind })),
    };
  }

  /** 房间可以存盘的全部内容（不含连接和计时器） */
  function snapshot(room) {
    return {
      v: SNAPSHOT_VERSION,
      code: room.code,
      mode: room.mode,
      phase: room.phase,
      hostSeat: room.hostSeat,
      seats: room.seats.map((s) => (s.kind === 'human' ? { kind: 'human', name: s.name, tokenHash: s.tokenHash, playerId: s.playerId } : { kind: s.kind })),
      seq: room.match?.seq ?? 0,
      save: room.match ? serializeSave(room.match.state) : null,
    };
  }

  /** 房间有变化：发给在线的人，然后存盘 */
  function changed(room) {
    for (const s of humans(room)) if (s.clientId) send(s.clientId, { t: 'room', room: roomView(room, s.clientId) });
    persist(room.code, snapshot(room));
  }

  function closeRoom(room) {
    room.match?.dispose();
    for (const s of room.seats) clearTimeout(s.holdTimer);
    clearTimeout(room.pauseTimer);
    for (const s of humans(room)) if (s.clientId) roomOf.delete(s.clientId);
    rooms.delete(room.code);
    persist(room.code, null);
  }

  /** 房主的座位没人了：交给下一位玩家（优先在线的） */
  function fixHost(room) {
    if (room.seats[room.hostSeat]?.kind === 'human') return;
    const list = room.seats.map((s, i) => [s, i]).filter(([s]) => s.kind === 'human');
    room.hostSeat = (list.find(([s]) => s.clientId) ?? list[0])[1];
  }

  /** 对局中所有人都不在线：开始倒计时，到期关闭房间；有人在线就取消 */
  function checkPause(room) {
    clearTimeout(room.pauseTimer);
    room.pauseTimer = null;
    if (room.phase !== 'playing' || humans(room).some((s) => s.clientId)) return;
    room.pauseTimer = setTimeout(() => closeRoom(room), pauseMs);
  }

  /** 大厅里不在线的座位保留 holdMs，到期时还没回来就让出 */
  function holdSeat(room, index) {
    const s = room.seats[index];
    clearTimeout(s.holdTimer);
    s.holdTimer = setTimeout(() => {
      // 期间可能已经重新连上、开了局，或者房间已经关了
      if (rooms.get(room.code) === room && room.phase === 'lobby' && room.seats[index] === s && s.clientId === null) vacate(room, index);
    }, holdMs);
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

  /** 让玩家坐进座位，发给他令牌 */
  function seat(room, index, clientId, name) {
    const token = newToken();
    room.seats[index] = { kind: 'human', clientId, name, tokenHash: hashToken(token), playerId: null, holdTimer: null };
    roomOf.set(clientId, room.code);
    send(clientId, { t: 'joined', code: room.code, token });
  }

  function create(clientId, msg) {
    const n = checkName(msg.name);
    if (n.error) return error(clientId, n.error);
    if (rooms.size >= maxRooms) return error(clientId, '服务器房间已满，请稍后再试');
    const code = newCode();
    if (!code) return error(clientId, '服务器房间已满，请稍后再试');
    const room = {
      code,
      mode: DEFAULT_MODE,
      phase: 'lobby',
      hostSeat: 0,
      seats: Array.from({ length: SEAT_COUNT }, (_, i) => ({ kind: i === 1 ? 'open' : 'closed' })),
      match: null,
      pauseTimer: null,
    };
    rooms.set(code, room);
    seat(room, 0, clientId, n.name);
    changed(room);
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
    seat(room, index, clientId, n.name);
    changed(room);
  }

  /** 凭令牌回到原来的座位。同一个令牌从新页面连上时，旧页面被断开 */
  function resume(clientId, msg) {
    const room = rooms.get(normalizeRoomCode(msg.code));
    const hash = hashToken(msg.token);
    const index = room ? room.seats.findIndex((s) => s.kind === 'human' && s.tokenHash === hash) : -1;
    if (index < 0) return send(clientId, { t: 'resumeFailed', message: room ? '你已经不在这个房间里了' : '房间已经关闭了' });
    const s = room.seats[index];
    if (s.clientId && s.clientId !== clientId) {
      roomOf.delete(s.clientId);
      kick(s.clientId);
    }
    clearTimeout(s.holdTimer);
    s.holdTimer = null;
    s.clientId = clientId;
    roomOf.set(clientId, room.code);
    checkPause(room);
    send(clientId, { t: 'joined', code: room.code, token: msg.token });
    changed(room);
    if (room.phase === 'playing') {
      send(clientId, { t: 'started', you: s.playerId });
      room.match.setOnline(s.playerId, true, `${s.name} 重新连上了`);
    }
  }

  /** 让出座位：大厅里变回空位，对局中标为已离开（由 AI 代打到结束）。没有玩家了就关闭房间 */
  function vacate(room, index) {
    const s = room.seats[index];
    clearTimeout(s.holdTimer);
    if (s.clientId) roomOf.delete(s.clientId);
    // 先让出座位再广播，离开的人不会再收到这局的消息
    room.seats[index] = { kind: room.phase === 'lobby' ? 'open' : 'gone' };
    if (room.phase === 'playing') room.match.setOnline(s.playerId, false, `${s.name} 离开了对局，之后由 AI 代打`);
    if (humans(room).length === 0) return closeRoom(room);
    fixHost(room);
    checkPause(room);
    changed(room);
  }

  /** 连接断了但没说要离开：保留座位 */
  function drop(clientId) {
    const room = roomFor(clientId);
    roomOf.delete(clientId);
    if (!room) return;
    const index = seatOf(room, clientId);
    const s = room.seats[index];
    s.clientId = null;
    if (room.phase === 'lobby') holdSeat(room, index);
    else {
      room.match.setOnline(s.playerId, false, `${s.name} 掉线了，由 AI 代打；重新连上后可以接着玩`);
    }
    checkPause(room);
    changed(room);
  }

  /** 房主在大厅里才能做的操作 */
  function hostRoom(clientId) {
    const room = roomFor(clientId);
    if (!room) return { error: '你不在房间里' };
    if (room.hostSeat !== seatOf(room, clientId)) return { error: '只有房主可以修改设置' };
    if (room.phase !== 'lobby') return { error: '对局已经开始了' };
    return { room };
  }

  function setMode(clientId, msg) {
    const { room, error: e } = hostRoom(clientId);
    if (e) return error(clientId, e);
    if (!Object.hasOwn(MODES, msg.mode)) return error(clientId, `未知对局模式: ${msg.mode}`);
    room.mode = msg.mode;
    changed(room);
  }

  function setSeat(clientId, msg) {
    const { room, error: e } = hostRoom(clientId);
    if (e) return error(clientId, e);
    if (msg.index >= SEAT_COUNT) return error(clientId, '座位不存在');
    if (room.seats[msg.index].kind === 'human') return error(clientId, '这个座位已经有玩家了');
    room.seats[msg.index] = { kind: msg.kind };
    changed(room);
  }

  /** 建立对局：新开局或读回存盘的对局 */
  function attachMatch(room, state, { seq = 0, offline = [] } = {}) {
    room.match = createMatch({
      ...matchOptions,
      state,
      seq,
      offline,
      humans: humans(room).map((s) => s.playerId),
      broadcast: (msg) => {
        for (const s of humans(room)) if (s.clientId) send(s.clientId, msg);
      },
      onUpdate: () => persist(room.code, snapshot(room)),
    });
  }

  function start(clientId) {
    const { room, error: e } = hostRoom(clientId);
    if (e) return error(clientId, e);
    if (room.seats.some((s) => s.kind === 'open')) return error(clientId, '还有空位：等人加入，或把空位改成 AI 或关闭');
    const seated = room.seats.filter((s) => s.kind !== 'closed');
    if (seated.length < RULES.minPlayers) return error(clientId, `至少要 ${RULES.minPlayers} 位玩家`);
    // 掉线保留中的座位也算人，但开局时必须都在线，免得一开局就由 AI 代打
    const away = humans(room).filter((s) => !s.clientId);
    if (away.length > 0) return error(clientId, `${away.map((s) => s.name).join('、')} 掉线了，等他们回来或开局前请他们重新加入`);

    // AI 按座位取名，避开玩家已经用了的名字。名字表和座位一样多，一定够用
    const taken = new Set(humans(room).map((s) => s.name));
    const spare = SEAT_NAMES.filter((n) => !taken.has(n));
    const players = seated.map((s) => (s.kind === 'human' ? { name: s.name, isAI: false } : { name: spare.shift(), isAI: true, aiLevel: s.kind }));
    const seed = randomInt(2 ** 32);
    const rules = rulesFor(room.mode, players.length);
    const challenge = { code: encodeChallenge({ mode: room.mode, kinds: seatKinds(players), seed }), daily: null };
    const state = createInitialState({ board, rules, cards: CARDS, players, seed, mode: room.mode, challenge });
    seated.forEach((s, i) => {
      if (s.kind === 'human') s.playerId = state.players[i].id;
    });
    room.phase = 'playing';
    attachMatch(room, state);
    changed(room);
    for (const s of humans(room)) send(s.clientId, { t: 'started', you: s.playerId });
    room.match.begin();
  }

  /** 对局中的房间和这位玩家的 id */
  function playing(clientId) {
    const room = roomFor(clientId);
    if (!room || room.phase !== 'playing') return { error: '你不在对局中' };
    return { room, playerId: room.seats[seatOf(room, clientId)].playerId };
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
    const room = roomFor(clientId);
    if (!room || room.phase !== 'playing') return error(clientId, '你不在对局中');
    if (room.hostSeat !== seatOf(room, clientId)) return error(clientId, '只有房主可以带大家回房间');
    if (room.match.state.phase !== PHASES.GAME_OVER) return error(clientId, '对局还没结束');
    room.match.dispose();
    room.match = null;
    room.phase = 'lobby';
    room.seats = room.seats.map((s) => (s.kind === 'gone' ? { kind: 'open' } : s));
    room.seats.forEach((s, index) => {
      if (s.kind !== 'human') return;
      s.playerId = null;
      // 回到大厅时还没连上的人，按大厅规则保留座位
      if (!s.clientId) holdSeat(room, index);
    });
    checkPause(room);
    changed(room);
  }

  /**
   * 读回一个存盘的房间（服务器重启后）。检查不通过返回错误原因，房间不会加进来。
   * 读回后所有人都不在线：大厅里的座位开始保留倒计时，对局暂停等人回来。
   * @param {unknown} snap
   * @returns {string | null}
   */
  function restore(snap) {
    const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
    if (!isObj(snap) || snap.v !== SNAPSHOT_VERSION) return '房间存档版本不对';
    const code = snap.code;
    if (typeof code !== 'string' || code.length !== ROOM_CODE_LENGTH || ![...code].every((c) => ROOM_CODE_ALPHABET.includes(c))) return '房间码无效';
    if (rooms.has(code)) return '房间码重复';
    if (rooms.size >= maxRooms) return '房间数已到上限';
    if (!Object.hasOwn(MODES, snap.mode)) return '模式无效';
    if (snap.phase !== 'lobby' && snap.phase !== 'playing') return '房间阶段无效';
    if (!Array.isArray(snap.seats) || snap.seats.length !== SEAT_COUNT) return '座位无效';
    for (const s of snap.seats) {
      if (!isObj(s) || !SEAT_KINDS.includes(s.kind)) return '座位无效';
      if (s.kind !== 'human') continue;
      if (typeof s.name !== 'string' || checkName(s.name).name !== s.name) return '玩家名字无效';
      if (typeof s.tokenHash !== 'string' || s.tokenHash.length === 0 || s.tokenHash.length > 128) return '令牌无效';
    }
    const seats = snap.seats.map((s) =>
      s.kind === 'human' ? { kind: 'human', name: s.name, tokenHash: s.tokenHash, playerId: s.playerId ?? null, clientId: null, holdTimer: null } : { kind: s.kind },
    );
    if (seats.filter((s) => s.kind === 'human').length === 0) return '房间里没有玩家';
    if (!(Number.isInteger(snap.hostSeat) && seats[snap.hostSeat]?.kind === 'human')) return '房主无效';
    if (new Set(seats.filter((s) => s.kind === 'human').map((s) => s.tokenHash)).size !== seats.filter((s) => s.kind === 'human').length) return '令牌重复';

    let state = null;
    if (snap.phase === 'playing') {
      const loaded = importSave(snap.save, saveCtx);
      if (!loaded.ok) return `对局存档无效：${loaded.error}${loaded.details ? `（${loaded.details.slice(0, 3).join('；')}）` : ''}`;
      state = loaded.state;
      const human = seats.filter((s) => s.kind === 'human');
      const ids = new Set();
      for (const s of human) {
        const p = state.players.find((x) => x.id === s.playerId);
        if (!p || p.isAI || ids.has(s.playerId)) return '座位和对局玩家对不上';
        ids.add(s.playerId);
      }
      if (!(Number.isInteger(snap.seq) && snap.seq >= 0)) return '批次序号无效';
    } else if (snap.save !== null || seats.some((s) => s.kind === 'gone')) return '大厅里不该有对局数据';

    const room = { code, mode: snap.mode, phase: snap.phase, hostSeat: snap.hostSeat, seats, match: null, pauseTimer: null };
    rooms.set(code, room);
    if (state) {
      // 刚读回时谁都不在线；已离开的玩家也在其中，由 AI 代打
      attachMatch(room, state, { seq: snap.seq, offline: state.players.filter((p) => !p.isAI).map((p) => p.id) });
    } else {
      seats.forEach((s, index) => {
        if (s.kind !== 'human') return;
        s.playerId = null;
        holdSeat(room, index);
      });
    }
    checkPause(room);
    return null;
  }

  const HANDLERS = { create, join, resume, setMode, setSeat, start, action, ready, toLobby };

  return {
    /**
     * 处理一条已通过 parseClientMessage 检查的消息。
     * @param {string} clientId
     * @param {{ t: string } & Record<string, unknown>} msg
     */
    handle(clientId, msg) {
      if (msg.t === 'leave') {
        const room = roomFor(clientId);
        if (!room) return error(clientId, '你不在房间里');
        vacate(room, seatOf(room, clientId));
        return send(clientId, { t: 'left' });
      }
      if ((msg.t === 'create' || msg.t === 'join' || msg.t === 'resume') && roomOf.has(clientId)) return error(clientId, '你已经在房间里了');
      HANDLERS[msg.t](clientId, msg);
    },
    /** 连接断开（不等于离开，座位保留） */
    disconnect(clientId) {
      if (roomOf.has(clientId)) drop(clientId);
    },
    restore,
    roomCount: () => rooms.size,
    /** 测试用：查看房间内部数据 */
    getRoom: (code) => rooms.get(code),
  };
}
