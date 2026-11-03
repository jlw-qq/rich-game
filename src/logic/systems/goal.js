/**
 * 逻辑层：短局目标资产的进度（纯函数，不改状态）。表现层用它画每个玩家的进度条，
 * 「本回合机会」用它算离目标还差多少，两处结果一致。
 */
import { netWorth } from './property.js';

/**
 * @typedef {{ id: string, worth: number, ratio: number, gap: number, leader: boolean }} GoalEntry
 * worth：总资产；ratio：worth / 目标，限制在 0–1（欠债为负时按 0）；gap：离目标还差多少（已达到为 0）；
 * leader：总资产最高（并列时都算领先）。
 */

/**
 * @param {{ state: object, board: object, rules: object }} ctx
 * @returns {{ goal: number, players: GoalEntry[] } | null} 没有目标资产（经典模式）时为 null；
 *   players 按座位顺序，只含没破产的玩家
 */
export function goalProgress(ctx) {
  const goal = ctx.rules.goalNetWorth;
  if (!(goal > 0)) return null;
  const alive = ctx.state.players.filter((p) => !p.bankrupt);
  const worths = alive.map((p) => netWorth(ctx, p.id));
  const best = Math.max(...worths);
  return {
    goal,
    players: alive.map((p, i) => ({
      id: p.id,
      worth: worths[i],
      ratio: Math.min(1, Math.max(0, worths[i] / goal)),
      gap: Math.max(0, goal - worths[i]),
      leader: worths[i] === best,
    })),
  };
}
