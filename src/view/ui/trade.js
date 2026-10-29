/**
 * 表现层：发起交易的对话框。只收集输入；交易是否合法由逻辑层 proposeTrade 判断，错误信息原样显示。
 */
import { el } from './dom.js';
import { money } from './format.js';
import { GROUP_COLORS } from '../render/theme.js';

/**
 * @param {{
 *   root: HTMLDialogElement,
 *   onSubmit: (trade: { toId: string, give: object, take: object }) => string | null,
 * }} options onSubmit 返回错误信息，成功返回 null
 */
export function createTradeDialog({ root, onSubmit }) {
  /** 组内有建筑的地产不能交易（逻辑层也会拦截，这里只是提前禁用） */
  function hasBuildings(state, board, tile) {
    return board.getGroupTiles(tile.group).some((t) => state.properties[t.id].level > 0);
  }

  /** 一边的输入区：地产勾选 + 现金 + 出狱卡。返回 { node, read } */
  function sideEditor({ state, board, player, title, prefix }) {
    const owned = board.tiles.filter((t) => t.type === 'property' && state.properties[t.id].ownerId === player.id);
    const checks = owned.map((t) => {
      const locked = hasBuildings(state, board, t);
      const input = el('input', { type: 'checkbox', id: `${prefix}-${t.id}`, value: t.id, disabled: locked });
      const prop = state.properties[t.id];
      const note = locked ? '（组内有建筑）' : prop.mortgaged ? '（已抵押）' : '';
      return {
        input,
        node: el(
          'label',
          { class: 'trade-prop', for: `${prefix}-${t.id}` },
          input,
          el('span', { class: 'asset-swatch', style: `background:${GROUP_COLORS[t.group]}`, 'aria-hidden': 'true' }),
          `${t.name} · ${money(t.price)}`,
          note && el('span', { class: 'muted' }, note),
        ),
      };
    });
    const cash = el('input', { type: 'number', id: `${prefix}-cash`, min: 0, max: player.cash, step: 100, value: 0, inputmode: 'numeric' });
    const cards = player.jailFreeCards.length;
    const jail = el('input', { type: 'number', id: `${prefix}-jail`, min: 0, max: cards, step: 1, value: 0 });

    const node = el(
      'fieldset',
      { class: 'trade-side' },
      el('legend', {}, title),
      checks.length > 0 ? el('div', { class: 'trade-props' }, checks.map((c) => c.node)) : el('p', { class: 'muted' }, '没有地产'),
      el('label', { class: 'trade-field', for: `${prefix}-cash` }, `现金（最多 ${money(player.cash)}）`, cash),
      cards > 0 && el('label', { class: 'trade-field', for: `${prefix}-jail` }, `出狱卡（有 ${cards} 张）`, jail),
    );
    // 输入框的值可能是空字符串或小数，交给逻辑层校验前先转成数字
    const num = (input) => (input.value.trim() === '' ? 0 : Number(input.value));
    const read = () => ({
      properties: checks.filter((c) => c.input.checked).map((c) => c.input.value),
      cash: num(cash),
      jailCards: cards > 0 ? num(jail) : 0,
    });
    return { node, read };
  }

  /**
   * 打开对话框。
   * @param {{ state: object, board: object, playerId: string }} view
   */
  function open({ state, board, playerId }) {
    const me = state.players.find((p) => p.id === playerId);
    const others = state.players.filter((p) => p.id !== playerId && !p.bankrupt);
    if (!me || others.length === 0) return;
    let partnerId = others[0].id;

    const errorBox = el('p', { class: 'setup-errors', role: 'alert' });
    const body = el('div', { class: 'trade-body' });
    let mine;
    let theirs;

    function renderSides() {
      const partner = state.players.find((p) => p.id === partnerId);
      mine = sideEditor({ state, board, player: me, title: `${me.name} 拿出`, prefix: 'trade-give' });
      theirs = sideEditor({ state, board, player: partner, title: `换取 ${partner.name} 的`, prefix: 'trade-take' });
      body.replaceChildren(mine.node, theirs.node);
      errorBox.textContent = '';
    }

    const partnerSelect = el(
      'select',
      { id: 'trade-partner', onchange: (e) => ((partnerId = e.target.value), renderSides()) },
      others.map((p) => el('option', { value: p.id }, p.isAI ? `${p.name}（AI）` : p.name)),
    );

    function submit(e) {
      e.preventDefault();
      const error = onSubmit({ toId: partnerId, give: mine.read(), take: theirs.read() });
      if (error) errorBox.textContent = error;
      else root.close();
    }

    root.replaceChildren(
      el(
        'form',
        { class: 'trade-form', method: 'dialog', onsubmit: submit },
        el('h2', { id: 'trade-title' }, '发起交易'),
        el('label', { class: 'trade-field', for: 'trade-partner' }, '交易对象', partnerSelect),
        body,
        errorBox,
        el(
          'div',
          { class: 'actions' },
          el('button', { type: 'submit', class: 'btn btn-primary' }, '提议'),
          el('button', { type: 'button', class: 'btn', onclick: () => root.close() }, '取消'),
        ),
      ),
    );
    renderSides();
    root.showModal();
  }

  return {
    open,
    close: () => root.open && root.close(),
  };
}
