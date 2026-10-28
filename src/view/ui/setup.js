/**
 * 表现层：开局设置表单。校验交给逻辑层 validatePlayerSetup，这里只负责收集输入和显示错误。
 */
import { el } from './dom.js';
import { PLAYER_COLORS } from '../render/theme.js';

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
 *   onStart: (players: { name: string, isAI: boolean, aiLevel?: string }[]) => void,
 *   onImport: (file: File) => Promise<string | null>,
 * }} options onImport 返回错误信息，成功返回 null
 */
export function createSetup({ root, rules, validate, onStart, onImport }) {
  let count = 2;
  let resume = null;
  const names = [...DEFAULT_NAMES];
  // 默认第 1 位是人类，其余是普通 AI
  const kinds = DEFAULT_NAMES.map((_, i) => (i === 0 ? 'human' : 'normal'));

  function render() {
    const errorBox = el('ul', { class: 'setup-errors', role: 'alert' });

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
          onStart(players);
        },
      },
      el('h1', {}, '大富翁'),
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
