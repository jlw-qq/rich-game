/**
 * 表现层：终局结算表。排名由逻辑层 computeRanking 计算，这里只负责显示。
 */
import { el } from './dom.js';
import { brandHeading } from './brandHeading.js';
import { dateLabel, money, scoreText, shareText } from './format.js';
import { PLAYER_COLORS } from '../render/theme.js';

/**
 * 复制到剪贴板。剪贴板接口在非安全上下文或被拒绝时不可用，返回 false，由调用方提示手动复制。
 * @param {string} text
 */
async function copyText(text) {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    return false;
  }
}

/**
 * @param {{ code: string, daily: string | null, score: object | null, best: object | null, newBest: boolean }} c
 * @param {(code: string) => void} onReplay
 */
function challengeSection(c, onReplay) {
  const status = el('span', { class: 'muted', role: 'status' });
  const copyButton = (label, text) =>
    el(
      'button',
      {
        type: 'button',
        class: 'btn',
        onclick: async () => {
          status.textContent = (await copyText(text)) ? '已复制' : '复制失败，请手动选中文字复制';
        },
      },
      label,
    );
  const share = c.score && shareText(c);
  return el(
    'div',
    { class: 'results-challenge' },
    el('h3', {}, c.daily ? `${dateLabel(c.daily)}每日挑战` : '本局挑战码'),
    el('p', {}, el('code', { class: 'challenge-code' }, c.code), el('span', { class: 'muted' }, ' 别人输入这个码，就能玩到同样的开局和骰子')),
    c.score &&
      el(
        'p',
        {},
        `你的成绩：${scoreText(c.score)}`,
        c.newBest ? el('strong', { class: 'results-best' }, ' · 新纪录') : c.best && el('span', { class: 'muted' }, `（本机最好：${scoreText(c.best)}）`),
      ),
    share && el('pre', { class: 'challenge-share' }, share),
    el(
      'div',
      { class: 'actions' },
      copyButton('复制挑战码', c.code),
      share && copyButton('复制成绩', share),
      el('button', { type: 'button', class: 'btn', onclick: () => onReplay(c.code) }, '同一挑战再来一局'),
      status,
    ),
  );
}

/**
 * @param {HTMLElement} root
 * @param {{ onReplay?: (code: string) => void }} [options] onReplay：用同一个挑战码重开
 */
export function createResults(root, { onReplay = () => {} } = {}) {
  /**
   * @param {{ rows: ReturnType<typeof import('../../logic/core/results.js').computeRanking>,
   *           state: object,
   *           challenge?: { code: string, daily: string | null, score: object | null, best: object | null, newBest: boolean } | null }} view
   *   challenge：best 是本局之前的本机最好成绩，newBest 表示本局刷新了纪录
   */
  function show({ rows, state, challenge = null }) {
    const seatOf = (id) => state.players.findIndex((p) => p.id === id);
    const reason = {
      roundLimit: `打满 ${state.round} 轮回合上限，按总资产排名`,
      goal: `第 ${state.round} 轮有人总资产率先达到目标`,
    }[state.endReason] ?? '其他玩家全部破产';

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
      challenge && challengeSection(challenge, onReplay),
    );
    root.hidden = false;
  }

  function hide() {
    root.hidden = true;
    root.replaceChildren();
  }

  return { show, hide };
}
