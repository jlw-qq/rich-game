/**
 * 表现层：每日挑战排行榜。弹出对话框显示某一天的前 50 名，高亮本机那一条；
 * 结算卡里的「上榜」区块（填昵称、提交、显示名次）也在这里。
 */
import { el } from './dom.js';
import { dateLabel, money } from './format.js';
import { MAX_NICKNAME } from '../../logic/systems/leaderboard.js';

/** 榜上一行的成绩：「第 1/4 名 · 31,200 元 · 18 轮」 */
export function boardScoreText(s) {
  return `第 ${s.rank}/${s.players} 名 · ${s.bankrupt ? '已破产' : money(s.netWorth)} · ${s.round} 轮`;
}

/** 提交后的提示 */
export function submitResultText(r) {
  const where = r.rank ? `今日第 ${r.rank} 名 / 共 ${r.total} 人` : `共 ${r.total} 人，你暂时不在前 200 名`;
  return r.improved ? `已上榜：${where}` : `榜上保留的是你更好的一次：${where}`;
}

/**
 * @param {{ root: HTMLDialogElement, client: ReturnType<typeof import('../net/scores.js').createScoresClient> }} options
 */
export function createLeaderboardDialog({ root, client }) {
  let token = 0;

  function frame(date, body) {
    root.replaceChildren(
      el(
        'div',
        { class: 'board-dialog' },
        el('h2', { id: 'board-title' }, `${dateLabel(date)}每日挑战排行榜`),
        body,
        el('p', { class: 'muted board-note' }, '成绩由服务器重放整局核实，同一台设备每天只留最好的一次。'),
        el('div', { class: 'actions' }, el('button', { type: 'button', class: 'btn btn-primary', onclick: () => root.close() }, '关闭')),
      ),
    );
  }

  /** @param {string} date YYYY-MM-DD */
  async function open(date) {
    const mine = token + 1;
    token = mine;
    frame(date, el('p', { class: 'muted', role: 'status' }, '正在读取……'));
    if (!root.open) root.showModal();
    const r = await client.load(date);
    // 期间又打开了别的日期，丢掉旧结果
    if (mine !== token || !root.open) return;
    if (!r.ok) return frame(date, el('p', { role: 'alert' }, r.error));
    if (r.entries.length === 0) return frame(date, el('p', { class: 'muted' }, '今天还没有人上榜，打一局就是第一名。'));
    const me = client.entryFor(date);
    frame(
      date,
      el(
        'div',
        {},
        el('p', { class: 'muted' }, `共 ${r.total} 人上榜，显示前 ${r.entries.length} 名`),
        el(
          'ol',
          { class: 'board-list', 'aria-labelledby': 'board-title' },
          r.entries.map((e) =>
            el(
              'li',
              { class: `board-row${e.entryId === me ? ' board-me' : ''}`, 'aria-current': e.entryId === me ? 'true' : null },
              el('span', { class: 'board-rank' }, e.rank),
              el('span', { class: 'board-name' }, e.name, e.entryId === me ? el('span', { class: 'tag' }, '你') : null),
              el('span', { class: 'board-score' }, boardScoreText(e.score)),
            ),
          ),
        ),
      ),
    );
  }

  return { open };
}

/**
 * 结算卡里的「上榜」区块。重绘结算卡时复用同一个节点，填到一半的昵称和提交结果不会丢。
 * @param {{ code: string, date: string, actions: object[] }} game
 * @param {{ client: object, onView: (date: string) => void }} deps
 */
export function createSubmitSection(game, { client, onView }) {
  const status = el('p', { class: 'muted', role: 'status' });
  const input = el('input', {
    id: 'board-name',
    type: 'text',
    maxlength: MAX_NICKNAME,
    value: client.nickname(),
    placeholder: '你的昵称',
    autocomplete: 'nickname',
    required: true,
  });
  const button = el('button', { type: 'submit', class: 'btn btn-primary' }, '上榜');
  const form = el(
    'form',
    {
      class: 'board-submit',
      onsubmit: async (e) => {
        e.preventDefault();
        const name = input.value.trim();
        if (!name) {
          status.textContent = '请填写昵称';
          input.focus();
          return;
        }
        button.disabled = true;
        status.textContent = '正在核实成绩……';
        const r = await client.submit({ code: game.code, actions: game.actions, name });
        button.disabled = false;
        if (!r.ok) {
          status.textContent = r.error;
          return;
        }
        status.textContent = submitResultText(r);
        button.textContent = '更新昵称';
      },
    },
    el('label', { for: 'board-name' }, '昵称'),
    input,
    button,
    el('button', { type: 'button', class: 'btn', onclick: () => onView(game.date) }, '查看排行榜'),
  );
  return el('div', { class: 'results-board' }, el('h3', {}, '今日排行榜'), form, status);
}
