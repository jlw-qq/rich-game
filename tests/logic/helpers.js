/**
 * 测试用：放弃购买，并让所有人退出随后的拍卖，地产保持无主（拍卖之前“不买”的效果）。
 */
import { PHASES as P } from '../../src/logic/core/turnMachine.js';

export function declineNoAuction(game) {
  const r = game.declineProperty();
  while (r.ok && game.phase === P.AWAIT_AUCTION) game.auctionPass(game.actingPlayerId());
  return r;
}
