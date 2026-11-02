/**
 * 表现层：侧边面板（玩家信息、阶段提示、操作按钮、地产管理）。
 * 只读状态来渲染；按钮点击通过 onAction 交给 main.js 调用逻辑层。
 */
import { el } from './dom.js';
import { choiceDetail, money, tradeSideText } from './format.js';
import { calcRent } from '../../logic/systems/property.js';
import { minBid } from '../../logic/systems/auction.js';
import { turnHints } from '../../logic/systems/hints.js';
import { PLAYER_COLORS, GROUP_COLORS } from '../render/theme.js';

/**
 * @typedef {{ kind: string, label: string, primary?: boolean, danger?: boolean, tileId?: string }} Action
 */

/**
 * 把 turnHints 的结果写成提示文字。掷骰前才能升级，所以升级提示只在 awaitRoll 出现。
 * @returns {string[]}
 */
export function hintLines(state, board, rules, player) {
  const h = turnHints({ state, board, rules }, player.id);
  const tileName = (id) => board.tiles.find((t) => t.id === id).name;
  const name = (id) => state.players.find((p) => p.id === id)?.name;
  const lines = [];
  if (h.upgrades && state.phase === 'awaitRoll') {
    const { count, best } = h.upgrades;
    const head = count > 1 ? `可升级 ${count} 块地，最划算：` : '可升级：';
    lines.push(`${head}${tileName(best.tileId)} 花 ${money(best.cost)}，租金 ${money(best.from)} → ${money(best.to)}`);
  }
  const g = h.groups[0];
  if (g) {
    const reward = `凑齐整组，空地租金 ×${rules.groupRentMultiplier}，还能盖楼`;
    if (g.here) lines.push(`买下 ${tileName(g.tileId)} 就${reward}`);
    else if (g.ownerId === null) lines.push(`还差 ${tileName(g.tileId)}（无主）就${reward}`);
    else lines.push(`还差 ${tileName(g.tileId)} 就凑齐整组，它在 ${name(g.ownerId)} 手里，可以试试交易`);
  }
  if (h.goal) {
    // 目标金额已显示在顶部的目标栏，这里只写差距
    lines.push(
      h.goal.leaderId === player.id
        ? `你领先，离目标还差 ${money(h.goal.myGap)}`
        : `${name(h.goal.leaderId)} 领先，离目标还差 ${money(h.goal.leaderGap)}；你还差 ${money(h.goal.myGap)}`,
    );
  }
  return lines;
}

/** 终局按钮不受动画和 AI 回合影响 */
const ALWAYS_ENABLED = new Set(['rematch', 'newGame']);

/**
 * @param {{
 *   players: HTMLElement,
 *   status: HTMLElement,
 *   actions: HTMLElement,
 *   assets: HTMLElement,
 *   onAction: (action: Action) => void,
 *   maxTradesPerTurn: number,
 *   goal?: HTMLElement,
 *   hints?: HTMLElement,
 * }} roots goal 为显示剩余轮数和目标资产的元素；hints 为操作区里“本回合机会”的列表
 */
export function createPanel({ players, status, actions, assets, onAction, maxTradesPerTurn, goal = null, hints = null }) {
  /** 联网对局里自己的玩家 id，本机对局为 null */
  let viewer = null;
  /** 这一局的规则（拍卖最低加价要用） */
  let currentRules = null;
  const button = (action, disabled) =>
    el('button', {
      type: 'button',
      class: ['btn', action.primary && 'btn-primary', action.danger && 'btn-danger'].filter(Boolean).join(' '),
      disabled,
      // dataset 只写有值的项，避免出现 data-index="undefined"
      dataset: {
        kind: action.kind,
        ...(action.index !== undefined && { index: String(action.index) }),
        ...(action.disabled && { unavailable: 'true' }),
      },
      onclick: () => onAction(action),
      text: action.label,
    });

  /** 自己填出价：数字框 + 按钮。超出范围时浏览器先拦一次，逻辑层再校验 */
  function customBid(action, busy) {
    const input = el('input', {
      type: 'number',
      id: 'bid-amount',
      class: 'bid-input',
      min: action.min,
      max: action.max,
      step: 10,
      value: action.min,
      inputmode: 'numeric',
      'aria-label': `出价金额（${action.min}–${action.max} 元）`,
      disabled: busy,
    });
    return el(
      'form',
      {
        class: 'bid-form',
        onsubmit: (e) => {
          e.preventDefault();
          onAction({ kind: 'bid', amount: Number(input.value) });
        },
      },
      input,
      el('button', { type: 'submit', class: 'btn', disabled: busy, dataset: { kind: 'bid' } }, action.label),
    );
  }

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
            el(
              'div',
              { class: 'player-name' },
              el('span', {}, p.name, p.isAI ? el('span', { class: 'tag' }, 'AI') : null),
              p.bankrupt ? null : el('span', { class: 'player-cash' }, money(p.cash)),
            ),
            el(
              'div',
              { class: 'player-meta' },
              p.bankrupt
                ? '已破产'
                : [
                    `地产 ${ownedCount(p.id)} 块 · 总资产 ${money(game.netWorth(p.id))}`,
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
          : `轮到 ${player.name}，请掷骰。掷骰前可以和其他玩家交易地产`;
      case 'awaitTrade': {
        const t = state.pendingTrade;
        const name = (id) => state.players.find((p) => p.id === id)?.name;
        return `${name(t.fromId)} 想用「${tradeSideText(t.give, board)}」换 ${name(t.toId)} 的「${tradeSideText(t.take, board)}」。${name(t.toId)} 要接受吗？`;
      }
      case 'awaitChoice': {
        const pending = game.pendingChoice();
        if (!pending) return '';
        const lines = pending.options.map((o, i) => {
          const detail = choiceDetail(o);
          return `${i + 1}. ${o.label}${detail ? `——${detail}` : ''}`;
        });
        return `城市事件「${pending.card.title}」：${pending.card.text}\n${lines.join('\n')}`;
      }
      case 'awaitDecision': {
        const tile = board.getTile(player.position);
        return `${tile.name} 无人拥有，售价 ${money(tile.price)}。${player.name} 现有 ${money(player.cash)}，要买吗？`;
      }
      case 'awaitAuction': {
        const a = state.auction;
        const tile = board.tiles.find((t) => t.id === a.tileId);
        const name = (id) => state.players.find((p) => p.id === id)?.name;
        const turn = state.players.find((p) => p.id === a.active[a.turn]);
        const high = a.high === null ? `起拍价 ${money(a.start)}，还没人出价` : `当前最高 ${name(a.highId)} ${money(a.high)}`;
        return `拍卖 ${tile.name}（标价 ${money(tile.price)}）：${high}\n还在场：${a.active.map(name).join('、')}\n轮到 ${turn.name}（现金 ${money(turn.cash)}）出价或退出`;
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
        if (state.endReason === 'roundLimit') return `打满回合上限，${winner.name} 以总资产最高获胜`;
        if (state.endReason === 'goal') return `${winner.name} 总资产率先达到目标，获胜！`;
        return `${winner.name} 获胜！`;
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
          state.tradesThisTurn < maxTradesPerTurn && {
            kind: 'openTrade',
            label: `交易（本回合还可 ${maxTradesPerTurn - state.tradesThisTurn} 次）`,
          },
        ].filter(Boolean);
      case 'awaitTrade':
        return [
          { kind: 'acceptTrade', label: '接受交易', primary: true },
          { kind: 'rejectTrade', label: '拒绝' },
        ];
      case 'awaitChoice':
        return (game.pendingChoice()?.options ?? []).map((o, i) => ({
          kind: 'choose',
          index: i,
          label: o.label,
          primary: i === 0,
          disabled: !o.available,
        }));
      case 'awaitDecision':
        return [
          { kind: 'buy', label: '买下', primary: true },
          { kind: 'decline', label: '不买' },
        ];
      case 'awaitAuction': {
        const a = state.auction;
        const bidder = state.players.find((p) => p.id === a.active[a.turn]);
        const least = minBid({ state, rules: currentRules });
        // 第一口出起拍价；之后加 100（最低加价）或加 500
        const options = [least, a.high === null ? least + 400 : a.high + 500].filter((v, i, arr) => v <= bidder.cash && arr.indexOf(v) === i);
        return [
          ...options.map((amount, i) => ({ kind: 'bid', amount, label: `出价 ${money(amount)}`, primary: i === 0 })),
          { kind: 'bid', custom: true, min: least, max: bidder.cash, label: '出价' },
          { kind: 'pass', label: '退出拍卖' },
        ];
      }
      case 'awaitPayment':
        return [
          { kind: 'payDebt', label: '付款', primary: true },
          { kind: 'bankrupt', label: '宣告破产', danger: true },
        ];
      case 'turnEnd':
        return [{ kind: 'endTurn', label: state.doublesCount > 0 && !player.inJail ? '再掷一次' : '结束回合', primary: true }];
      case 'gameOver':
        return [
          { kind: 'rematch', label: viewer ? '回到房间' : '再来一局', primary: true },
          { kind: 'newGame', label: viewer ? '返回菜单' : '返回设置' },
        ];
      default:
        return [];
    }
  }

  function renderAssets(state, game, board, busy, rules) {
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
              el('span', { class: 'muted' }, prop.mortgaged ? ' 已抵押' : ` ${prop.level} 级 · 租 ${rules ? calcRent({ state, board, rules }, t.id) : t.rent[prop.level]}`),
            ),
            el('span', { class: 'asset-ops' }, ops.map((a) => button(a, busy))),
          );
        }),
      ),
    );
  }

  /**
   * @param {{ state: object, game: object, board: object, busy: boolean, rules?: object, me?: string | null }} view
   *   rules 为这一局的规则，用来显示剩余轮数和目标资产；
   *   me 为联网对局里自己的玩家 id（本机对局为 null），轮到别人时显示在等谁
   */
  function render({ state, game, board, busy, rules, me = null }) {
    viewer = me;
    currentRules = rules;
    renderPlayers(state, game);
    renderGoal(state, game, rules);
    const acting = state.players.find((p) => p.id === game.actingPlayerId());
    const waiting = me && acting && acting.id !== me && state.phase !== 'gameOver';
    status.textContent = waiting
      ? `等待 ${acting.name}${acting.isAI ? '（AI）' : ''} 操作…`
      : acting?.isAI && state.phase !== 'gameOver'
        ? `${acting.name}（AI）正在操作…`
        : statusText(state, game, board);
    actions.replaceChildren(
      ...mainActions(state, game).map((a) => (a.custom ? customBid(a, busy) : button(a, (busy && !ALWAYS_ENABLED.has(a.kind)) || Boolean(a.disabled)))),
    );
    renderAssets(state, game, board, busy, rules);
    renderHints(state, board, rules, acting && !waiting && !acting.isAI ? acting : null);
  }

  /**
   * 本回合机会：轮到本机真人、掷骰前或决定买地时，把能做的经营决策写成最多 3 行。
   * @param {object | null} player 正在操作的本机玩家；不是本机玩家时隐藏
   */
  function renderHints(state, board, rules, player) {
    if (!hints) return;
    const lines = player && rules && ['awaitRoll', 'awaitDecision'].includes(state.phase) ? hintLines(state, board, rules, player) : [];
    hints.hidden = lines.length === 0;
    hints.replaceChildren(...lines.map((text) => el('li', {}, text)));
  }

  /** 终局条件一直显示在侧栏：剩余轮数，以及（短局）目标资产和目前的领先者 */
  function renderGoal(state, game, rules) {
    if (!goal || !rules) return;
    if (state.phase === 'gameOver') {
      goal.hidden = true;
      return;
    }
    // “第 3/25 轮”比“剩余 22 轮”更不容易误读（当前这一轮算不算剩余）
    const last = state.round >= rules.maxRounds;
    const parts = [last ? `最后一轮（${rules.maxRounds}/${rules.maxRounds}）` : `第 ${state.round}/${rules.maxRounds} 轮`];
    if (rules.goalNetWorth > 0) {
      const alive = state.players.filter((p) => !p.bankrupt);
      const best = alive.reduce((a, b) => (game.netWorth(b.id) > game.netWorth(a.id) ? b : a));
      parts.push(`目标总资产 ${money(rules.goalNetWorth)}`, `领先：${best.name} ${money(game.netWorth(best.id))}`);
    }
    goal.hidden = false;
    goal.textContent = parts.join(' · ');
  }

  /** 动画播放中：只切换按钮的禁用状态，不重绘数字（避免提前显示结果） */
  function setBusy(busy) {
    const bidInput = actions.querySelector('.bid-input');
    if (bidInput) bidInput.disabled = busy;
    for (const b of [...actions.querySelectorAll('button'), ...assets.querySelectorAll('button')]) {
      // 本身不可选的选项（data-unavailable）动画结束后仍保持禁用
      if (!ALWAYS_ENABLED.has(b.dataset.kind)) b.disabled = busy || b.dataset.unavailable === 'true';
    }
  }

  return { render, setBusy };
}
