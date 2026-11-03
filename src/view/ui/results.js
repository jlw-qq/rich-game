/**
 * 表现层：终局结算表。排名由逻辑层 computeRanking 计算，这里只负责显示。
 */
import { el } from './dom.js';
import { brandHeading } from './brandHeading.js';
import { dateLabel, money, scoreText, shareText } from './format.js';
import { PLAYER_COLORS } from '../render/theme.js';
import { copyText, canShare, shareOrCopy, SHARE_STATUS, pageUrl } from './clipboard.js';
import { compareScores, encodeChallengeLink } from '../../logic/systems/shareLink.js';
import { SOLO_HUMAN_NAME } from '../../data/config/challenge.js';

/** 和朋友成绩的对比：「你 第 2/4 名 · 29,000 元 ／ 小红 第 1/4 名 · 31,200 元 → 小红赢了，总资产差 2,200 元」 */
export function compareText(mine, friend) {
  const who = friend.by ?? '朋友';
  const brief = (s) => `第 ${s.rank}/${s.players} 名 · ${s.bankrupt ? '已破产' : money(s.netWorth)}`;
  const result = compareScores(mine, friend.score);
  const gap = Math.abs(mine.netWorth - friend.score.netWorth);
  const verdict = { win: '你赢了', lose: `${who}赢了`, tie: '打平' }[result];
  const detail = result !== 'tie' && gap > 0 ? `，总资产差 ${money(gap)}` : '';
  return { result, text: `你 ${brief(mine)} ／ ${who} ${brief(friend.score)} → ${verdict}${detail}` };
}

/**
 * @param {{ code: string, daily: string | null, score: object | null, best: object | null, newBest: boolean,
 *           by?: string, friend?: { by: string | null, score: object } | null }} c
 *   by：自己的名字（写进挑战链接）；friend：打开朋友的挑战链接时带来的对方成绩
 * @param {(code: string) => void} onReplay
 */
function challengeSection(c, onReplay) {
  const status = el('span', { class: 'muted', role: 'status' });
  // 复制失败时把链接显示出来，让人手动选中复制
  const manual = el('input', { type: 'text', class: 'share-link', readonly: true, hidden: true, 'aria-label': '挑战链接', onfocus: (e) => e.target.select() });
  const link = pageUrl(encodeChallengeLink({ code: c.code, by: c.by && c.by !== SOLO_HUMAN_NAME ? c.by : '', score: c.score }));
  const shareButton = el(
    'button',
    {
      type: 'button',
      class: 'btn btn-primary',
      onclick: async () => {
        const r = await shareOrCopy({ title: '城市大富翁 · 挑战', text: c.score ? shareText(c) : `来玩同一局城市大富翁：挑战码 ${c.code}`, url: link });
        status.textContent = SHARE_STATUS[r];
        manual.hidden = r !== 'failed';
        if (r === 'failed') {
          manual.value = link;
          manual.focus();
        }
      },
    },
    canShare() ? '分享挑战链接' : '复制挑战链接',
  );
  const vs = c.score && c.friend ? compareText(c.score, c.friend) : null;
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
    vs && el('p', { class: `results-vs results-vs-${vs.result}` }, vs.text, el('span', { class: 'muted' }, '（对方成绩为自报）')),
    share && el('pre', { class: 'challenge-share' }, share),
    el(
      'div',
      { class: 'actions' },
      shareButton,
      copyButton('复制挑战码', c.code),
      share && copyButton('复制成绩', share),
      el('button', { type: 'button', class: 'btn', onclick: () => onReplay(c.code) }, '同一挑战再来一局'),
      status,
    ),
    manual,
  );
}

/**
 * @param {HTMLElement} root
 * @param {{ onReplay?: (code: string) => void, onRematch?: () => void, onNewGame?: () => void, onChangeLineup?: () => void }} [options]
 *   onReplay：用同一个挑战码重开；onRematch：同一阵容再来一局（联网时回到房间）；
 *   onNewGame：回开局页（联网时离开房间）；onChangeLineup：回开局页并展开玩家设置（只在本机对局出现）
 */
export function createResults(root, { onReplay = () => {}, onRematch = () => {}, onNewGame = () => {}, onChangeLineup = () => {} } = {}) {
  /**
   * @param {{ rows: ReturnType<typeof import('../../logic/core/results.js').computeRanking>,
   *           state: object,
   *           online?: boolean,
   *           challenge?: { code: string, daily: string | null, score: object | null, best: object | null, newBest: boolean } | null }} view
   *   challenge：best 是本局之前的本机最好成绩，newBest 表示本局刷新了纪录
   */
  function show({ rows, state, challenge = null, online = false }) {
    const seatOf = (id) => state.players.findIndex((p) => p.id === id);
    const reason = {
      roundLimit: `打满 ${state.round} 轮回合上限，按总资产排名`,
      goal: `第 ${state.round} 轮有人总资产率先达到目标`,
    }[state.endReason] ?? '其他玩家全部破产';

    root.replaceChildren(
      brandHeading('h2', 28, { id: 'results-title', suffix: '本局结算' }),
      el('p', { class: 'muted' }, reason),
      // 打完最常做的事是马上再来一局，按钮放在表格上面
      el(
        'div',
        { class: 'actions results-actions' },
        el('button', { type: 'button', class: 'btn btn-primary btn-large', dataset: { kind: 'rematch' }, onclick: onRematch }, online ? '回到房间' : '再来一局'),
        !online && el('button', { type: 'button', class: 'btn', onclick: onChangeLineup }, '换个阵容'),
        el('button', { type: 'button', class: 'btn', dataset: { kind: 'newGame' }, onclick: onNewGame }, online ? '返回菜单' : '返回首页'),
      ),
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
