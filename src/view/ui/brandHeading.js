/**
 * 表现层：带标志的游戏标题（开局界面、结算面板）。标志 SVG 是代码里的固定内容，不含用户输入。
 */
import { el } from './dom.js';
import { GAME_NAME, logoSvg } from '../brand.js';

/**
 * @param {'h1' | 'h2'} tag
 * @param {number} size 标志边长（像素）
 * @param {{ id?: string, suffix?: string }} [options] suffix 接在名字后面，如“本局结算”
 */
export function brandHeading(tag, size, { id, suffix } = {}) {
  const mark = el('span', { class: 'brand-mark' });
  mark.innerHTML = logoSvg(size);
  return el(
    tag,
    { class: 'brand', id },
    mark,
    el('span', { class: 'brand-name' }, GAME_NAME),
    suffix ? el('span', { class: 'brand-suffix' }, suffix) : null,
  );
}
