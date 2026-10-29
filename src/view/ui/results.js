/**
 * 表现层：终局结算表。排名由逻辑层 computeRanking 计算，这里只负责显示。
 */
import { el } from './dom.js';
import { brandHeading } from './brandHeading.js';
import { money } from './format.js';
import { PLAYER_COLORS } from '../render/theme.js';

/**
 * @param {HTMLElement} root
 */
export function createResults(root) {
  /**
   * @param {{ rows: ReturnType<typeof import('../../logic/core/results.js').computeRanking>,
   *           state: object }} view
   */
  function show({ rows, state }) {
    const seatOf = (id) => state.players.findIndex((p) => p.id === id);
    const reason =
      state.endReason === 'roundLimit'
        ? `打满 ${state.round} 轮回合上限，按总资产排名`
        : '其他玩家全部破产';

    root.replaceChildren(
      brandHeading('h2', 28, { id: 'results-title', suffix: '本局结算' }),
      el('p', { class: 'muted' }, reason),
      el(
        'table',
        { class: 'results-table', 'aria-labelledby': 'results-title' },
        el('thead', {}, el('tr', {}, ['名次', '玩家', '现金', '地产', '总资产'].map((h) => el('th', { scope: 'col' }, h)))),
        el(
          'tbody',
          {},
          rows.map((r) =>
            el(
              'tr',
              { class: r.winner ? 'results-winner' : r.bankrupt ? 'results-bankrupt' : null },
              el('td', {}, r.winner ? '🏆 1' : r.rank),
              el(
                'th',
                { scope: 'row' },
                el(
                  'span',
                  { class: 'player-dot player-seat', style: `background:${PLAYER_COLORS[seatOf(r.playerId)]}`, 'aria-hidden': 'true' },
                  seatOf(r.playerId) + 1,
                ),
                ` ${r.name}`,
              ),
              el('td', {}, r.bankrupt ? `第 ${r.bankruptOrder} 个破产` : money(r.cash)),
              el('td', {}, r.bankrupt ? '—' : `${r.properties} 块`),
              el('td', {}, r.bankrupt ? '—' : money(r.netWorth)),
            ),
          ),
        ),
      ),
    );
    root.hidden = false;
  }

  function hide() {
    root.hidden = true;
    root.replaceChildren();
  }

  return { show, hide };
}
