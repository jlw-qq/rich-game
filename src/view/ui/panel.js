/**
 * 表现层：侧边面板（玩家信息、阶段提示、操作按钮、地产管理）。
 * 只读状态来渲染；按钮点击通过 onAction 交给 main.js 调用逻辑层。
 */
import { el } from './dom.js';
import { money } from './format.js';
import { PLAYER_COLORS, GROUP_COLORS } from '../render/theme.js';

/**
 * @typedef {{ kind: string, label: string, primary?: boolean, danger?: boolean, tileId?: string }} Action
 */

/** 终局按钮不受动画和 AI 回合影响 */
const ALWAYS_ENABLED = new Set(['rematch', 'newGame']);

/**
 * @param {{
 *   players: HTMLElement,
 *   status: HTMLElement,
 *   actions: HTMLElement,
 *   assets: HTMLElement,
 *   onAction: (action: Action) => void,
 * }} roots
 */
export function createPanel({ players, status, actions, assets, onAction }) {
  const button = (action, disabled) =>
    el('button', {
      type: 'button',
      class: ['btn', action.primary && 'btn-primary', action.danger && 'btn-danger'].filter(Boolean).join(' '),
      disabled,
      dataset: { kind: action.kind },
      onclick: () => onAction(action),
      text: action.label,
    });

  function renderPlayers(state, game) {
    // 终局后不再高亮“当前玩家”（可能指向刚破产的人）
    const current = state.phase === 'gameOver' ? null : game.currentPlayer()?.id;
    const ownedCount = (id) => Object.values(state.properties).filter((p) => p.ownerId === id).length;
    players.replaceChildren(
      ...state.players.map((p, i) =>
        el(
          'li',
          {
            class: ['player', p.id === current && 'player-current', p.bankrupt && 'player-bankrupt'].filter(Boolean).join(' '),
            'aria-current': p.id === current ? 'true' : null,
          },
          el('span', { class: 'player-dot player-seat', style: `background:${PLAYER_COLORS[i]}`, 'aria-hidden': 'true' }, i + 1),
          el(
            'div',
            { class: 'player-info' },
            el('div', { class: 'player-name' }, p.name, p.isAI ? el('span', { class: 'tag' }, 'AI') : null),
            el(
              'div',
              { class: 'player-meta' },
              p.bankrupt
                ? '已破产'
                : [
                    `现金 ${money(p.cash)}`,
                    ` · 地产 ${ownedCount(p.id)} 块`,
                    ` · 总资产 ${money(game.netWorth(p.id))}`,
                    p.inJail ? ' · 坐牢中' : '',
                    p.jailFreeCards.length > 0 ? ` · 出狱卡 ×${p.jailFreeCards.length}` : '',
                  ].join(''),
            ),
          ),
        ),
      ),
    );
  }

  /** 当前阶段的提示文字 */
  function statusText(state, game, board) {
    const player = game.currentPlayer();
    switch (state.phase) {
      case 'awaitRoll':
        return player.inJail
          ? `${player.name} 在监狱中（第 ${player.jailTurns + 1} 回合）：掷出双数可出狱，也可以交保释金或用出狱卡`
          : `轮到 ${player.name}，请掷骰`;
      case 'awaitDecision': {
        const tile = board.getTile(player.position);
        return `${tile.name} 无人拥有，售价 ${money(tile.price)}。${player.name} 现有 ${money(player.cash)}，要买吗？`;
      }
      case 'awaitPayment': {
        const debt = state.pendingDebt;
        const debtor = state.players.find((p) => p.id === debt.debtorId);
        return `${debtor.name} 需要支付 ${money(debt.amount)}，现金 ${money(debtor.cash)}。可以卖建筑或抵押地产凑钱，实在不够只能宣告破产`;
      }
      case 'turnEnd':
        return state.doublesCount > 0 && !player.inJail ? `${player.name} 掷出了双数，结束后可以再掷一次` : `${player.name} 的回合结束`;
      case 'gameOver': {
        const winner = state.players.find((p) => p.id === state.winnerId);
        if (!winner) return '游戏结束';
        return state.endReason === 'roundLimit' ? `打满回合上限，${winner.name} 以总资产最高获胜` : `${winner.name} 获胜！`;
      }
      default:
        return '';
    }
  }

  /** @returns {Action[]} */
  function mainActions(state, game) {
    const player = game.currentPlayer();
    switch (state.phase) {
      case 'awaitRoll':
        return [
          { kind: 'roll', label: player.inJail ? '掷骰（求双数出狱）' : '掷骰', primary: true },
          player.inJail && { kind: 'bail', label: '交保释金' },
          player.inJail && player.jailFreeCards.length > 0 && { kind: 'jailCard', label: '用出狱卡' },
        ].filter(Boolean);
      case 'awaitDecision':
        return [
          { kind: 'buy', label: '买下', primary: true },
          { kind: 'decline', label: '不买' },
        ];
      case 'awaitPayment':
        return [
          { kind: 'payDebt', label: '付款', primary: true },
          { kind: 'bankrupt', label: '宣告破产', danger: true },
        ];
      case 'turnEnd':
        return [{ kind: 'endTurn', label: state.doublesCount > 0 && !player.inJail ? '再掷一次' : '结束回合', primary: true }];
      case 'gameOver':
        return [
          { kind: 'rematch', label: '再来一局', primary: true },
          { kind: 'newGame', label: '返回设置' },
        ];
      default:
        return [];
    }
  }

  function renderAssets(state, game, board, busy) {
    const actingId = game.actingPlayerId();
    const phase = state.phase;
    const canInvest = phase === 'awaitRoll';
    const canLiquidate = ['awaitRoll', 'awaitDecision', 'awaitPayment', 'turnEnd'].includes(phase);
    const owned = board.tiles.filter((t) => t.type === 'property' && state.properties[t.id].ownerId === actingId);

    if (phase === 'gameOver') {
      assets.replaceChildren(el('p', { class: 'muted' }, '对局已结束'));
      return;
    }
    if (!actingId || owned.length === 0) {
      assets.replaceChildren(el('p', { class: 'muted' }, '当前玩家还没有地产'));
      return;
    }
    assets.replaceChildren(
      el(
        'ul',
        { class: 'asset-list' },
        owned.map((t) => {
          const prop = state.properties[t.id];
          const ops = [
            canInvest && !prop.mortgaged && { kind: 'upgrade', label: '升级', tileId: t.id },
            canLiquidate && prop.level > 0 && { kind: 'sell', label: '卖建筑', tileId: t.id },
            canLiquidate && !prop.mortgaged && prop.level === 0 && { kind: 'mortgage', label: '抵押', tileId: t.id },
            canInvest && prop.mortgaged && { kind: 'redeem', label: '赎回', tileId: t.id },
          ].filter(Boolean);
          return el(
            'li',
            { class: 'asset' },
            el('span', { class: 'asset-swatch', style: `background:${GROUP_COLORS[t.group]}`, 'aria-hidden': 'true' }),
            el(
              'span',
              { class: 'asset-name' },
              t.name,
              el('span', { class: 'muted' }, prop.mortgaged ? ' 已抵押' : ` ${prop.level} 级 · 租 ${t.rent[prop.level]}`),
            ),
            el('span', { class: 'asset-ops' }, ops.map((a) => button(a, busy))),
          );
        }),
      ),
    );
  }

  /**
   * @param {{ state: object, game: object, board: object, busy: boolean }} view
   */
  function render({ state, game, board, busy }) {
    renderPlayers(state, game);
    const acting = state.players.find((p) => p.id === game.actingPlayerId());
    status.textContent =
      acting?.isAI && state.phase !== 'gameOver' ? `${acting.name}（AI）正在操作…` : statusText(state, game, board);
    actions.replaceChildren(...mainActions(state, game).map((a) => button(a, busy && !ALWAYS_ENABLED.has(a.kind))));
    renderAssets(state, game, board, busy);
  }

  /** 动画播放中：只切换按钮的禁用状态，不重绘数字（避免提前显示结果） */
  function setBusy(busy) {
    for (const b of [...actions.querySelectorAll('button'), ...assets.querySelectorAll('button')]) {
      if (!ALWAYS_ENABLED.has(b.dataset.kind)) b.disabled = busy;
    }
  }

  return { render, setBusy };
}
