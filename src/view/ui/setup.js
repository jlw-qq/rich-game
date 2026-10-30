/**
 * 表现层：开局界面。校验交给逻辑层 validatePlayerSetup，这里只负责收集输入和显示错误。
 *
 * 第一屏只讲一件事：10 分钟和朋友争夺城市地产。下面三个入口（开短局 / 和朋友联机 / 今日挑战），
 * 选中哪个就展开哪个的设置；对局模式、导入存档这些不常用的收在「更多设置」里。
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
 *   onCreateRoom: (name: string) => Promise<string | null>,
 *   onJoinRoom: (code: string, name: string) => Promise<string | null>,
 * }} options onImport、onCode、onCreateRoom、onJoinRoom 返回错误信息，成功返回 null；daily 给出今天的日期和本机最好成绩
 */
export function createSetup({ root, rules, validate, onStart, onImport, daily, onDaily, onCode, onCreateRoom, onJoinRoom }) {
  /** 当前展开的入口：local 开短局 / online 和朋友联机 / daily 今日挑战 */
  let entry = 'local';
  /** 「更多设置」是否展开（重绘时保持） */
  let moreOpen = false;
  // 默认你和 3 个普通 AI，和每日挑战的阵容一样
  let count = 4;
  let resume = null;
  let mode = DEFAULT_MODE;
  const names = [...DEFAULT_NAMES];
  /** 联网时用的名字，默认取 1 号玩家的名字 */
  let onlineName = '';
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
    const roomInput = el('input', {
      id: 'setup-room',
      type: 'text',
      maxlength: 8,
      placeholder: '4 位房间码',
      autocomplete: 'off',
      spellcheck: 'false',
      onkeydown: (e) => {
        if (e.key !== 'Enter') return;
        e.preventDefault();
        online(() => onJoinRoom(roomInput.value, nameInput.value));
      },
    });
    const nameInput = el('input', {
      id: 'setup-online-name',
      type: 'text',
      maxlength: 12,
      value: onlineName || names[0],
      autocomplete: 'off',
      oninput: (e) => (onlineName = e.target.value),
    });
    /** 联网按钮在等服务器回应时禁用，避免重复点 */
    const online = async (run) => {
      const buttons = [...root.querySelectorAll('.setup-online button')];
      buttons.forEach((b) => (b.disabled = true));
      const error = await run();
      buttons.forEach((b) => (b.disabled = false));
      if (error) errorBox.replaceChildren(el('li', {}, error));
    };
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

    const localPanel = [
      el('div', { class: 'setup-row' }, el('label', { for: 'setup-count' }, '玩家人数'), countSelect),
      rows,
      el('p', { class: 'muted setup-hint' }, '人类玩家轮流在同一台电脑上操作。全部设为 AI 就是观战模式。'),
      el('button', { type: 'submit', class: 'btn btn-primary btn-large' }, mode === DEFAULT_MODE ? '开始短局' : `开始${MODES[mode].name}`),
    ];

    const onlinePanel = [
      el('div', { class: 'setup-row' }, el('label', { for: 'setup-online-name' }, '你的名字'), nameInput),
      el('button', { type: 'button', class: 'btn btn-primary btn-large', onclick: () => online(() => onCreateRoom(nameInput.value)) }, '创建房间'),
      el(
        'div',
        { class: 'setup-row' },
        el('label', { for: 'setup-room' }, '或者加入'),
        roomInput,
        el('button', { type: 'button', class: 'btn', onclick: () => online(() => onJoinRoom(roomInput.value, nameInput.value)) }, '加入'),
      ),
      el('p', { class: 'muted setup-hint' }, '每人用自己的手机或电脑打开同一个服务器地址。房主创建房间后，把 4 位房间码告诉朋友。'),
    ];

    const dailyPanel = [
      el(
        'p',
        { class: 'setup-mode-text' },
        el('strong', {}, `${dateLabel(today.dateKey)} · ${dailyLineup}`),
        el('span', { class: 'muted' }, today.best ? `本机最好：${scoreText(today.best)}` : '所有人今天玩的是同一局，可以重玩，只记最好成绩'),
      ),
      el('button', { type: 'button', id: 'setup-daily', class: 'btn btn-primary btn-large', onclick: onDaily }, '开始今日挑战'),
      el(
        'div',
        { class: 'setup-row' },
        el('label', { for: 'setup-code' }, '挑战码'),
        codeInput,
        el('button', { type: 'button', class: 'btn', onclick: startCode }, '开始'),
      ),
      el('p', { class: 'muted setup-hint' }, '输入朋友发来的挑战码，能玩到和他完全一样的开局和骰子。'),
    ];

    const ENTRIES = [
      { key: 'local', title: '开短局', note: '约 10 分钟 · 和 AI 或身边的人', panel: localPanel },
      { key: 'online', title: '和朋友联机', note: '各用各的设备，进同一个房间', panel: onlinePanel },
      { key: 'daily', title: '今日挑战', note: `${dateLabel(today.dateKey)} · 所有人同一局`, panel: dailyPanel },
    ];
    const current = ENTRIES.find((e) => e.key === entry);

    const more = el(
      'details',
      { class: 'setup-more', open: moreOpen, ontoggle: (e) => (moreOpen = e.target.open) },
      el('summary', {}, '更多设置'),
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
              onchange: () => {
                mode = key;
                render();
              },
            }),
            el('span', { class: 'setup-mode-text' }, el('strong', {}, m.name), el('span', { class: 'muted' }, m.blurb)),
          ),
        ),
      ),
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
      el('p', { class: 'muted' }, '本机对局每回合结束自动存档，下次打开可以继续。'),
    );

    const form = el(
      'form',
      {
        class: 'setup-form setup-home',
        onsubmit: (e) => {
          e.preventDefault();
          // 只有「开短局」用表单提交（在名字框里按回车也会走到这里）
          if (entry !== 'local') return;
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
      el(
        'div',
        { class: 'setup-hero' },
        brandHeading('h1', 44),
        el('p', { class: 'setup-tagline' }, '10 分钟，和朋友争夺城市地产'),
        el('p', { class: 'muted' }, '掷骰买地、盖楼收租、和对手讨价还价，最先攒到 30,000 元的人拿下这座城市。'),
      ),
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
        'div',
        { class: 'setup-entries', role: 'group', 'aria-label': '怎么玩' },
        ENTRIES.map((e) =>
          el(
            'button',
            {
              type: 'button',
              class: 'setup-entry',
              'aria-pressed': String(e.key === entry),
              'aria-controls': 'setup-panel',
              onclick: () => {
                if (entry === e.key) return;
                entry = e.key;
                render();
                root.querySelector('.setup-entry[aria-pressed="true"]')?.focus();
              },
            },
            el('strong', {}, e.title),
            el('span', {}, e.note),
          ),
        ),
      ),
      el(
        'div',
        { class: `setup-panel${entry === 'online' ? ' setup-online' : ''}`, id: 'setup-panel', role: 'region', 'aria-label': current.title },
        current.panel,
      ),
      errorBox,
      more,
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
      (root.querySelector('.setup-resume .btn-primary') ?? root.querySelector('.setup-entry[aria-pressed="true"]'))?.focus();
    },
    hide() {
      root.hidden = true;
    },
  };
}
