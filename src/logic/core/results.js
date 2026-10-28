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
