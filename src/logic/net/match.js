/**
 * 逻辑层：服务器上运行的一局联网对局。所有操作都在这里执行，客户端只发操作、收结果。
 *
 * 每次状态变化后广播 { t: 'update', seq, events, state, notice? }：events 是这次操作产生的事件
 * （客户端拿去播动画），state 是之后的完整状态（客户端直接替换）。
 *
 * 节奏：客户端播完一批事件后回 ready(seq)。服务器等所有在线玩家都 ready（最多等 readyTimeoutMs），
 * 再让 AI 走下一步，或开始给人类玩家计时。这样动画慢的人也不会被甩在后面，计时也不会在别人还在看动画时就开始。
 * 人类玩家一步超过 turnTimeoutMs 没操作，AI 替他走这一步；掉线的玩家由 AI 代打，重新连上后接着自己操作。
 * 所有人类玩家都不在线时对局暂停（AI 也不走），有人回来再继续。
 */
import { createEventBus } from '../core/eventBus.js';
import { createGame } from '../core/game.js';
import { performAction } from '../core/actions.js';
import { PHASES } from '../core/turnMachine.js';
import { createAiDriver } from '../ai/driver.js';
import { createBoard } from '../core/board.js';
import { TILES, GROUPS } from '../../data/config/board.js';
import { RULES } from '../../data/config/rules.js';
import { CARDS } from '../../data/config/cards.js';
import { rulesFor } from '../../data/config/modes.js';

export const AI_DELAY_MS = 600;
export const TURN_TIMEOUT_MS = 60_000;
export const READY_TIMEOUT_MS = 8_000;

const board = createBoard({ tiles: TILES, groups: GROUPS, rules: RULES });

/**
 * @param {{
 *   state: object,
 *   humans: string[],
 *   broadcast: (msg: object) => void,
 *   aiDelayMs?: number,
 *   turnTimeoutMs?: number,
 *   readyTimeoutMs?: number,
 *   offline?: string[],
 *   seq?: number,
 *   onUpdate?: () => void,
 * }} options humans：人类玩家 id；offline：开始时不在线的玩家（服务器重启后读回的对局全部不在线）；
 *   seq：上次发到第几批（读回的对局接着编号）；onUpdate：每次广播后调用（服务器在这里存盘）
 */
export function createMatch({
  state,
  humans,
  broadcast,
  aiDelayMs = AI_DELAY_MS,
  turnTimeoutMs = TURN_TIMEOUT_MS,
  readyTimeoutMs = READY_TIMEOUT_MS,
  offline = [],
  seq: startSeq = 0,
  onUpdate = () => {},
}) {
  const rules = rulesFor(state.mode, state.players.length);
  const bus = createEventBus({ onError: (err) => console.error('对局事件出错', err) });
  const game = createGame({ board, rules, state, bus, cards: CARDS });
  /** 不在线的玩家，由 AI 代打 */
  const gone = new Set(offline);
  /** 这一步超时、交给 AI 代走一次的玩家 */
  let proxyOnce = null;
  const driver = createAiDriver({
    game,
    state,
    board,
    rules,
    cards: CARDS,
    controls: (p) => p.isAI || gone.has(p.id) || p.id === proxyOnce,
  });

  let events = [];
  bus.on('*', (payload, type) => events.push([type, payload]));
  let seq = startSeq;
  /** 还没回 ready 的在线玩家 */
  let waitingFor = new Set();
  let timer = null;
  let disposed = false;

  const online = () => humans.filter((id) => !gone.has(id));
  const nameOf = (id) => state.players.find((p) => p.id === id)?.name ?? id;
  const over = () => state.phase === PHASES.GAME_OVER;

  function clearTimer() {
    if (timer) clearTimeout(timer);
    timer = null;
  }

  /** 把攒下的事件和最新状态发给所有人，然后等大家播完 */
  function flush(notice) {
    seq += 1;
    const msg = { t: 'update', seq, events, state };
    if (notice) msg.notice = notice;
    events = [];
    broadcast(msg);
    onUpdate();
    waitingFor = new Set(online());
    clearTimer();
    if (over()) return;
    if (waitingFor.size === 0) next();
    else timer = setTimeout(next, readyTimeoutMs);
  }

  /** 所有人都看完了：轮到 AI 就走一步，轮到人类就开始计时；没人在线时暂停 */
  function next() {
    clearTimer();
    waitingFor.clear();
    if (disposed || over() || online().length === 0) return;
    if (driver.isAiTurn()) {
      timer = setTimeout(aiStep, aiDelayMs);
      return;
    }
    const acting = game.actingPlayerId();
    timer = setTimeout(() => {
      proxyOnce = acting;
      aiStep(`${nameOf(acting)} 超过 ${Math.round(turnTimeoutMs / 1000)} 秒没有操作，由 AI 代走一步`);
    }, turnTimeoutMs);
  }

  function aiStep(notice) {
    timer = null;
    if (disposed || over()) return;
    const r = driver.step();
    proxyOnce = null;
    if (r?.fallback) console.warn('AI 改用兜底操作：', r.error);
    flush(notice);
  }

  return {
    /** 开局时发一次初始状态 */
    begin() {
      flush();
    },
    /**
     * 玩家发来的操作。只能由当前有权操作的玩家发出（还款时是欠款人，交易时是被提议的一方）。
     * @returns {{ ok: boolean, error?: string }}
     */
    act(playerId, action) {
      if (disposed) return { ok: false, error: '对局已结束' };
      if (over()) return { ok: false, error: '对局已结束' };
      if (game.actingPlayerId() !== playerId) return { ok: false, error: '还没轮到你操作' };
      const result = performAction(game, action);
      if (!result.ok) {
        events = [];
        return { ok: false, error: result.error };
      }
      flush();
      return { ok: true };
    },
    /** 客户端播完了第 n 批事件 */
    ready(playerId, n) {
      if (n !== seq || !waitingFor.has(playerId)) return;
      waitingFor.delete(playerId);
      if (waitingFor.size === 0) next();
    },
    /**
     * 玩家上线或下线，并把最新状态连同说明发给所有在线的人（重新连上的玩家靠这一批拿到当前局面）。
     * 下线的玩家轮到时直接由 AI 走；所有人都下线时暂停。对局结束后也照样发，回来的人能看到结算。
     * @param {string} playerId
     * @param {boolean} isOnline
     * @param {string} notice
     */
    setOnline(playerId, isOnline, notice) {
      if (disposed) return;
      if (isOnline) gone.delete(playerId);
      else gone.add(playerId);
      flush(notice);
    },
    dispose() {
      disposed = true;
      clearTimer();
    },
    get state() {
      return state;
    },
    get seq() {
      return seq;
    },
    /** 测试用：现在是否在等计时器（暂停时为 false） */
    get waiting() {
      return timer !== null;
    },
    stats: driver.stats,
  };
}
