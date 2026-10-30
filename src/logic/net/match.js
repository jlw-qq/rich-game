/**
 * 逻辑层：服务器上运行的一局联网对局。所有操作都在这里执行，客户端只发操作、收结果。
 *
 * 每次状态变化后广播 { t: 'update', seq, events, state, notice? }：events 是这次操作产生的事件
 * （客户端拿去播动画），state 是之后的完整状态（客户端直接替换）。
 *
 * 节奏：客户端播完一批事件后回 ready(seq)。服务器等所有在线玩家都 ready（最多等 readyTimeoutMs），
 * 再让 AI 走下一步，或开始给人类玩家计时。这样动画慢的人也不会被甩在后面，计时也不会在别人还在看动画时就开始。
 * 人类玩家一步超过 turnTimeoutMs 没操作，AI 替他走这一步；掉线的玩家一直由 AI 代打。
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
 * }} options humans：在线的人类玩家 id
 */
export function createMatch({ state, humans, broadcast, aiDelayMs = AI_DELAY_MS, turnTimeoutMs = TURN_TIMEOUT_MS, readyTimeoutMs = READY_TIMEOUT_MS }) {
  const rules = rulesFor(state.mode, state.players.length);
  const bus = createEventBus({ onError: (err) => console.error('对局事件出错', err) });
  const game = createGame({ board, rules, state, bus, cards: CARDS });
  /** 掉线的玩家，由 AI 代打 */
  const gone = new Set();
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
  let seq = 0;
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
    waitingFor = new Set(online());
    clearTimer();
    if (over()) return;
    if (waitingFor.size === 0) next();
    else timer = setTimeout(next, readyTimeoutMs);
  }

  /** 所有人都看完了：轮到 AI 就走一步，轮到人类就开始计时 */
  function next() {
    clearTimer();
    waitingFor.clear();
    if (disposed || over()) return;
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
    /** 玩家掉线，之后一直由 AI 代打 */
    leave(playerId) {
      if (gone.has(playerId)) return;
      gone.add(playerId);
      if (disposed || over()) return;
      // 告诉其他人；之后轮到他时不再计时，直接由 AI 走
      flush(`${nameOf(playerId)} 离开了对局，之后由 AI 代打`);
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
    stats: driver.stats,
  };
}
