/**
 * 表现层：开局设置表单。校验交给逻辑层 validatePlayerSetup，这里只负责收集输入和显示错误。
 */
import { el } from './dom.js';
import { PLAYER_COLORS } from '../render/theme.js';
import { brandHeading } from './brandHeading.js';
import { DEFAULT_MODE, MODES } from '../../data/config/modes.js';
import { DAILY_CHALLENGE } from '../../data/config/challenge.js';
import { dateLabel, scoreText } from './format.js';

const DEFAULT_NAMES = ['小红', '小蓝', '小黄', '小绿', '小紫'];

/** 玩家类型选项：value → 开局参数 */
const KINDS = {
  human: { label: '人类', isAI: false },
  normal: { label: 'AI · 普通', isAI: true, aiLevel: 'normal' },
  easy: { label: 'AI · 简单', isAI: true, aiLevel: 'easy' },
};

/**
 * @param {{
 *   root: HTMLElement,
 *   rules: { minPlayers: number, maxPlayers: number },
 *   validate: (players: object[]) => string[],
 *   onStart: (players: { name: string, isAI: boolean, aiLevel?: string }[], mode: string) => void,
 *   onImport: (file: File) => Promise<string | null>,
 *   daily: () => { dateKey: string, best: object | null },
 *   onDaily: () => void,
 *   onCode: (text: string) => string | null,
 * }} options onImport、onCode 返回错误信息，成功返回 null；daily 给出今天的日期和本机最好成绩
 */
export function createSetup({ root, rules, validate, onStart, onImport, daily, onDaily, onCode }) {
  let count = 2;
  let resume = null;
  let mode = DEFAULT_MODE;
  const names = [...DEFAULT_NAMES];
  // 默认第 1 位是人类，其余是普通 AI
  const kinds = DEFAULT_NAMES.map((_, i) => (i === 0 ? 'human' : 'normal'));

  /** 每日挑战的阵容说明：短局 · 你和 3 个普通 AI */
  const dailyLineup = (() => {
    const ai = DAILY_CHALLENGE.kinds.filter((k) => k !== 'human');
    const levels = [...new Set(ai)].map((k) => KINDS[k].label.replace('AI · ', '')).join('/');
    return `${MODES[DAILY_CHALLENGE.mode].name} · 你和 ${ai.length} 个${levels} AI`;
  })();

  function render() {
    const errorBox = el('ul', { class: 'setup-errors', role: 'alert' });
    const today = daily();
    const codeInput = el('input', {
      id: 'setup-code',
      type: 'text',
      maxlength: 40,
      placeholder: 'CR-XXXX-XXXX-XXXX',
      autocomplete: 'off',
      spellcheck: 'false',
      // 在挑战码框里按回车是开挑战，不是提交下面的新游戏表单
      onkeydown: (e) => {
        if (e.key !== 'Enter') return;
        e.preventDefault();
        startCode();
      },
    });
    const startCode = () => {
      const error = onCode(codeInput.value);
      if (error) {
        errorBox.replaceChildren(el('li', {}, error));
        codeInput.focus();
      }
    };

    const rows = Array.from({ length: count }, (_, i) =>
      el(
        'div',
        { class: 'setup-row' },
        el('span', { class: 'player-dot player-seat', style: `background:${PLAYER_COLORS[i]}`, 'aria-hidden': 'true' }, i + 1),
        el('label', { for: `setup-name-${i}` }, `玩家 ${i + 1}`),
        el('input', {
          id: `setup-name-${i}`,
          type: 'text',
          maxlength: 12,
          value: names[i],
          autocomplete: 'off',
          oninput: (e) => (names[i] = e.target.value),
        }),
        el(
          'select',
          {
            id: `setup-kind-${i}`,
            class: 'setup-kind',
            'aria-label': `玩家 ${i + 1} 类型`,
            onchange: (e) => (kinds[i] = e.target.value),
          },
          Object.entries(KINDS).map(([value, k]) => el('option', { value, selected: kinds[i] === value }, k.label)),
        ),
      ),
    );

    const countSelect = el(
      'select',
      {
        id: 'setup-count',
        onchange: (e) => {
          count = Number(e.target.value);
          render();
        },
      },
      Array.from({ length: rules.maxPlayers - rules.minPlayers + 1 }, (_, k) => {
        const n = rules.minPlayers + k;
        return el('option', { value: n, selected: n === count }, `${n} 人`);
      }),
    );

    const form = el(
      'form',
      {
        class: 'setup-form',
        onsubmit: (e) => {
          e.preventDefault();
          const players = names.slice(0, count).map((name, i) => {
            const { isAI, aiLevel } = KINDS[kinds[i]];
            return isAI ? { name, isAI, aiLevel } : { name, isAI };
          });
          const errors = validate(players);
          if (errors.length > 0) {
            errorBox.replaceChildren(...errors.map((msg) => el('li', {}, msg)));
            return;
          }
          onStart(players, mode);
        },
      },
      brandHeading('h1', 44),
      resume &&
        el(
          'div',
          { class: 'setup-resume', role: 'group', 'aria-label': '上一局' },
          el('p', {}, resume.label),
          el(
            'div',
            { class: 'actions' },
            el('button', { type: 'button', class: 'btn btn-primary', onclick: resume.onResume }, '继续上一局'),
            el('button', { type: 'button', class: 'btn btn-danger', onclick: resume.onDiscard }, '删除存档'),
          ),
        ),
      el(
        'fieldset',
        { class: 'setup-challenge' },
        el('legend', {}, '挑战'),
        el(
          'div',
          { class: 'setup-daily' },
          el('button', { type: 'button', id: 'setup-daily', class: 'btn btn-primary', onclick: onDaily }, '今日挑战'),
          el(
            'span',
            { class: 'setup-mode-text' },
            el('strong', {}, `${dateLabel(today.dateKey)} · ${dailyLineup}`),
            el('span', { class: 'muted' }, today.best ? `本机最好：${scoreText(today.best)}` : '所有人今天玩的是同一局，可以重玩，只记最好成绩'),
          ),
        ),
        el(
          'div',
          { class: 'setup-row' },
          el('label', { for: 'setup-code' }, '挑战码'),
          codeInput,
          el('button', { type: 'button', class: 'btn', onclick: startCode }, '开始'),
        ),
      ),
      el(
        'fieldset',
        { class: 'setup-modes' },
        el('legend', {}, '对局模式'),
        Object.entries(MODES).map(([key, m]) =>
          el(
            'label',
            { class: 'setup-mode', for: `setup-mode-${key}` },
            el('input', {
              type: 'radio',
              name: 'setup-mode',
              id: `setup-mode-${key}`,
              value: key,
              checked: mode === key,
              onchange: () => (mode = key),
            }),
            el('span', { class: 'setup-mode-text' }, el('strong', {}, m.name), el('span', { class: 'muted' }, m.blurb)),
          ),
        ),
      ),
      el('div', { class: 'setup-row' }, el('label', { for: 'setup-count' }, '玩家人数'), countSelect),
      rows,
      errorBox,
      el('button', { type: 'submit', class: 'btn btn-primary btn-large' }, '开始新游戏'),
      el(
        'div',
        { class: 'setup-row' },
        el('label', { for: 'setup-import' }, '导入存档'),
        el('input', {
          id: 'setup-import',
          type: 'file',
          accept: '.json,application/json',
          onchange: async (e) => {
            const file = e.target.files?.[0];
            e.target.value = '';
            if (!file) return;
            const error = await onImport(file);
            if (error) errorBox.replaceChildren(el('li', {}, error));
          },
        }),
      ),
      el('p', { class: 'muted' }, '人类玩家轮流在同一台电脑上操作。全部设为 AI 就是观战模式。每回合结束自动存档。'),
    );

    root.replaceChildren(form);
  }

  return {
    /**
     * @param {{ resume?: { label: string, onResume: () => void, onDiscard: () => void } | null, message?: string }} [options]
     *   resume：有可继续的存档时显示；message：要提示的错误（如存档损坏）
     */
    show({ resume: r = null, message = '' } = {}) {
      resume = r;
      root.hidden = false;
      render();
      if (message) root.querySelector('.setup-errors')?.replaceChildren(el('li', {}, message));
      (root.querySelector('.setup-resume .btn-primary') ?? root.querySelector('input'))?.focus();
    },
    hide() {
      root.hidden = true;
    },
  };
}
