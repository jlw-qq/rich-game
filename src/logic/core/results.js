/**
 * 逻辑层：终局排名。
 * 规则：存活玩家排在前面，按总资产从高到低（并列时按座位顺序）；
 * 破产玩家排在后面，越晚破产名次越高。赢家（state.winnerId）一定是第 1 名。
 */
import { netWorth } from '../systems/property.js';

/**
 * @param {{ state: object, board: object }} ctx
 * @returns {{ rank: number, playerId: string, name: string, bankrupt: boolean, bankruptOrder: number | null,
 *             cash: number, properties: number, netWorth: number, winner: boolean }[]}
 */
export function computeRanking(ctx) {
  const { state } = ctx;
  const rows = state.players.map((p, seat) => ({
    seat,
    playerId: p.id,
    name: p.name,
    bankrupt: p.bankrupt,
    bankruptOrder: p.bankruptOrder,
    cash: p.cash,
    properties: Object.values(state.properties).filter((prop) => prop.ownerId === p.id).length,
    netWorth: p.bankrupt ? 0 : netWorth(ctx, p.id),
    winner: p.id === state.winnerId,
  }));

  rows.sort((a, b) => {
    if (a.winner !== b.winner) return a.winner ? -1 : 1;
    if (a.bankrupt !== b.bankrupt) return a.bankrupt ? 1 : -1;
    if (a.bankrupt) return b.bankruptOrder - a.bankruptOrder;
    return b.netWorth - a.netWorth || a.seat - b.seat;
  });
  return rows.map(({ seat, ...row }, i) => ({ rank: i + 1, ...row }));
}

/**
 * 挑战成绩：第一位人类玩家的名次、总资产和结束轮数。全 AI 对局没有成绩，返回 null。
 * @param {{ state: object, board: object }} ctx
 * @returns {{ rank: number, players: number, bankrupt: boolean, netWorth: number, round: number } | null}
 */
export function challengeScore(ctx) {
  const human = ctx.state.players.find((p) => !p.isAI);
  if (!human) return null;
  const row = computeRanking(ctx).find((r) => r.playerId === human.id);
  return { rank: row.rank, players: ctx.state.players.length, bankrupt: row.bankrupt, netWorth: row.netWorth, round: ctx.state.round };
}

/** 读回来的本地记录可能被改过，用之前先确认形状 */
export function isChallengeScore(v) {
  const posInt = (n) => Number.isInteger(n) && n >= 1;
  return (
    v !== null && typeof v === 'object' && posInt(v.rank) && posInt(v.players) && v.rank <= v.players &&
    typeof v.bankrupt === 'boolean' && Number.isInteger(v.netWorth) && v.netWorth >= 0 && posInt(v.round)
  );
}

/** a 是否比 b 好：名次靠前优先，其次总资产高，再其次用的轮数少。b 为空时 a 总是更好 */
export function isBetterScore(a, b) {
  if (!b) return true;
  if (a.rank !== b.rank) return a.rank < b.rank;
  if (a.netWorth !== b.netWorth) return a.netWorth > b.netWorth;
  return a.round < b.round;
}
