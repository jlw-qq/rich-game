/**
 * 逻辑层：统一的操作描述 → 对局方法。UI 按钮和 AI 都通过这里执行操作。
 * action：{ kind, tileId?, trade?, index? }。index 为城市事件的选项下标。操作人一律取 game.actingPlayerId()，调用方不能替别人操作。
 */

export const ACTION_KINDS = [
  'roll',
  'bail',
  'jailCard',
  'buy',
  'decline',
  'payDebt',
  'bankrupt',
  'endTurn',
  'upgrade',
  'sell',
  'mortgage',
  'redeem',
  'proposeTrade',
  'acceptTrade',
  'rejectTrade',
  'choose',
];

/**
 * @param {object} game createGame 的返回值
 * @param {{ kind: string, tileId?: string, trade?: object, index?: number }} action
 * @returns {{ ok: boolean, error?: string }}
 */
export function performAction(game, action) {
  const me = game.actingPlayerId();
  switch (action?.kind) {
    case 'roll':
      return game.rollDice();
    case 'bail':
      return game.payBail();
    case 'jailCard':
      return game.useJailFreeCard();
    case 'buy':
      return game.buyProperty();
    case 'decline':
      return game.declineProperty();
    case 'payDebt':
      return game.payDebt();
    case 'bankrupt':
      return game.declareBankruptcy();
    case 'endTurn':
      return game.endTurn();
    case 'upgrade':
      return game.upgrade(me, action.tileId);
    case 'sell':
      return game.sellBuilding(me, action.tileId);
    case 'mortgage':
      return game.mortgage(me, action.tileId);
    case 'redeem':
      return game.redeem(me, action.tileId);
    case 'proposeTrade':
      return game.proposeTrade(me, action.trade);
    case 'acceptTrade':
      return game.acceptTrade();
    case 'rejectTrade':
      return game.rejectTrade();
    case 'choose':
      return game.chooseOption(action.index);
    default:
      return { ok: false, error: `未知操作: ${action?.kind}` };
  }
}
