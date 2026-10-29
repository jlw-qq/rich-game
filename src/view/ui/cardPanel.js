/**
 * 表现层：侧栏里的地产详情卡片。棋盘画布太小时，棋盘中央只显示城市名，
 * 售价、租金、所有者、建筑等详细信息在这里用正常字号显示。
 */
import { el } from './dom.js';
import { money } from './format.js';
import { GROUP_HEADERS, PLAYER_COLORS } from '../render/theme.js';
import { upgradeText } from '../render/tileCard.js';

/** @param {HTMLElement} root */
export function createCardPanel(root) {
  let lastKey = null;

  /**
   * @param {import('../render/tileCard.js').TileCard | null} card null 时隐藏
   * @param {string} label 来源角标：落点 / 查看
   */
  function render(card, label) {
    // 每帧都会调用，内容不变时不碰 DOM
    const key = card ? JSON.stringify([card, label]) : null;
    if (key === lastKey) return;
    lastKey = key;
    root.hidden = !card;
    if (!card) return root.replaceChildren();

    const header = GROUP_HEADERS[card.group];
    const rent = card.mortgaged ? '已抵押，免租' : money(card.rent);
    const houses = Array.from({ length: card.maxLevel }, (_, k) => el('span', { class: k < card.level ? 'house house-built' : 'house' }));
    root.replaceChildren(
      el(
        'div',
        { class: 'tile-card-header', style: `background:${header.bg};color:${header.text}` },
        el('strong', {}, card.name),
        el('span', { class: 'tile-card-tag' }, label),
      ),
      el(
        'dl',
        { class: 'tile-card-body' },
        el('dt', {}, '售价'),
        el('dd', {}, money(card.price)),
        el('dt', {}, card.owner ? '租金' : '空地租金'),
        el('dd', {}, rent, card.groupBonus ? el('span', { class: 'muted' }, '（整组 ×2）') : null),
        el('dt', {}, '所有者'),
        el(
          'dd',
          {},
          card.owner
            ? [el('span', { class: 'player-dot', style: `background:${PLAYER_COLORS[card.owner.index]}`, 'aria-hidden': 'true' }), ` ${card.owner.name}`]
            : '无主 · 可购买',
        ),
        el('dt', {}, '建筑'),
        el(
          'dd',
          {},
          el('span', { class: 'houses', 'aria-hidden': 'true' }, houses),
          ` 等级 ${card.level}/${card.maxLevel}`,
          ` · ${upgradeText(card, money)}`,
        ),
      ),
    );
  }

  return { render };
}
