/**
 * 逻辑层：按挑战码和人类玩家的操作记录重放一局，得出服务器认可的成绩。
 *
 * 开局只由挑战码决定（模式、座位类型、种子）；之后骰子、卡牌、AI 决策各有存在 state 里的随机数状态，
 * 所以只要按顺序重放人类的操作、AI 的回合交给同一个 AI 执行器，就会得到和玩家本机一模一样的对局。
 * 记录里任何一步不合法、提前用完、或对局结束后还有剩，都算核实失败。
 */
import { createGame } from '../core/game.js';
import { createInitialState } from '../core/gameState.js';
import { createEventBus } from '../core/eventBus.js';
import { performAction } from '../core/actions.js';
import { cleanLoggedAction, MAX_LOGGED_ACTIONS } from '../core/actionLog.js';
import { challengeScore } from '../core/results.js';
import { PHASES } from '../core/turnMachine.js';
import { createAiDriver } from '../ai/driver.js';
import { challengePlayers, decodeChallenge } from './challenge.js';
import { rulesFor } from '../../data/config/modes.js';

/** 重放总步数上限（人类 + AI）。人类破产后 AI 之间还会继续打，正常短局几千步以内 */
export const MAX_REPLAY_STEPS = 50000;

const fail = (error) => ({ ok: false, error });

/**
 * @param {{ board: object, cards: object[] }} ctx
 * @param {{ code: unknown, actions: unknown }} submission
 * @returns {{ ok: true, code: string, config: object, score: object, state: object } | { ok: false, error: string }}
 *   score 为第一位人类玩家的成绩（见 challengeScore）
 */
export function replayChallenge({ board, cards }, { code, actions }) {
  const decoded = decodeChallenge(code);
  if (!decoded.ok) return fail(decoded.error);
  const { config } = decoded;
  if (!config.kinds.includes('human')) return fail('这个挑战没有人类玩家');
  if (!Array.isArray(actions)) return fail('操作记录必须是数组');
  if (actions.length > MAX_LOGGED_ACTIONS) return fail(`操作记录超过 ${MAX_LOGGED_ACTIONS} 步`);
  const log = [];
  for (let i = 0; i < actions.length; i++) {
    const a = cleanLoggedAction(actions[i]);
    if (!a) return fail(`第 ${i + 1} 步格式无效`);
    log.push(a);
  }

  const players = challengePlayers(config.kinds);
  const rules = rulesFor(config.mode, players.length);
  const state = createInitialState({ board, rules, cards, players, seed: config.seed, mode: config.mode, challenge: { code: decoded.code, daily: null } });
  // 事件监听器只用于界面，这里不需要；出错也不应影响重放
  const game = createGame({ board, rules, state, bus: createEventBus({ onError: () => {} }), cards });
  const driver = createAiDriver({ game, state, board, rules, cards });

  let next = 0;
  for (let steps = 0; state.phase !== PHASES.GAME_OVER; steps++) {
    if (steps >= MAX_REPLAY_STEPS) return fail('重放步数超出上限');
    if (driver.isAiTurn()) {
      driver.step();
      continue;
    }
    if (next >= log.length) return fail(`操作记录在第 ${state.round} 轮就用完了，对局还没结束`);
    const result = performAction(game, log[next]);
    if (!result.ok) return fail(`第 ${next + 1} 步（${log[next].kind}）不合法：${result.error}`);
    next += 1;
  }
  if (next !== log.length) return fail(`对局已结束，操作记录还多出 ${log.length - next} 步`);
  const score = challengeScore({ state, board });
  return { ok: true, code: decoded.code, config, score, state };
}
