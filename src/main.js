/**
 * 入口：组装逻辑层与表现层。
 * 依赖方向只允许 main/view -> logic -> data，反向引用由 tests/architecture.test.js 拦截。
 *
 * 数据流：UI 按钮 → game 操作 → 逻辑层同步发事件 → animator 排队逐个播放（日志、音效、动画）
 *        → 全部播完后重绘面板并自动存档。面板数字在动画结束后才更新，避免结果提前剧透。
 */
import { TILES, GROUPS } from './data/config/board.js';
import { RULES } from './data/config/rules.js';
import { CARDS } from './data/config/cards.js';
import { createSaveStore, MAX_SAVE_LENGTH } from './data/save/saveFormat.js';
import { createBoard } from './logic/core/board.js';
import { createEventBus } from './logic/core/eventBus.js';
import { createInitialState, validatePlayerSetup } from './logic/core/gameState.js';
import { createGame } from './logic/core/game.js';
import { performAction } from './logic/core/actions.js';
import { checkLoadedState, exportSave, importSave } from './logic/core/saveGame.js';
import { computeRanking } from './logic/core/results.js';
import { PHASES } from './logic/core/turnMachine.js';
import { createAiDriver } from './logic/ai/driver.js';
import { createBoardRenderer } from './view/render/boardRenderer.js';
import { createAnimator } from './view/render/animator.js';
import { createSound } from './view/audio/sound.js';
import { formatEvent } from './view/ui/format.js';
import { createLog } from './view/ui/log.js';
import { createPanel } from './view/ui/panel.js';
import { createResults } from './view/ui/results.js';
import { createSetup } from './view/ui/setup.js';

const $ = (id) => document.getElementById(id);

const board = createBoard({ tiles: TILES, groups: GROUPS, rules: RULES });
const saveCtx = { board, rules: RULES, cards: CARDS };
const canvas = /** @type {HTMLCanvasElement} */ ($('board'));
const renderer = createBoardRenderer(canvas);
const sound = createSound();
const log = createLog($('log'));
const results = createResults($('results'));
const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)');

/** localStorage 在隐私模式或沙箱里可能不可用，访问本身就会抛错 */
function getStorage() {
  try {
    return window.localStorage;
  } catch {
    return null;
  }
}
const saveStore = createSaveStore(getStorage());

/** 事件 → 音效 */
const EVENT_SOUNDS = {
  diceRolled: 'dice',
  propertyBought: 'buy',
  propertyUpgraded: 'buy',
  passedStart: 'coin',
  cashGained: 'coin',
  paymentMade: 'pay',
  sentToJail: 'jail',
  playerBankrupt: 'jail',
  gameOver: 'win',
};
/** 需要醒目显示的日志 */
const HIGHLIGHT_EVENTS = new Set(['turnStarted', 'playerBankrupt', 'gameOver', 'debtPending']);

/** AI 每步操作之间的间隔（毫秒） */
const AI_DELAY_MS = 600;

/** 当前对局，开局前为 null */
let session = null;
let frameRequested = false;
/** 自动存档失败只提示一次，避免刷屏 */
let saveErrorShown = false;

function requestFrame() {
  if (frameRequested) return;
  frameRequested = true;
  requestAnimationFrame(frame);
}

function frame(now) {
  frameRequested = false;
  const animator = session?.animator;
  const needMore = animator ? animator.tick(now) : false;
  renderer.draw({
    board,
    state: session?.state ?? null,
    tokens: animator?.tokens ?? null,
    dice: animator?.dice ?? null,
    floaters: animator?.floaters ?? [],
    currentPlayerId: session && session.state.phase !== PHASES.GAME_OVER ? (session.game.currentPlayer()?.id ?? null) : null,
  });
  if (needMore) requestFrame();
}

/** 动画播完、状态稳定时自动存档；终局后删除存档（没有可继续的内容） */
function autosave() {
  const { state } = session;
  if (state.phase === PHASES.GAME_OVER) {
    saveStore.clear();
    return;
  }
  const r = saveStore.save(state);
  if (!r.ok && !saveErrorShown) {
    saveErrorShown = true;
    log.add(r.error, 'error');
  }
}

function renderPanel() {
  if (!session) return;
  const { state, game, animator, driver } = session;
  // AI 回合中人类按钮全部禁用
  panel.render({ state, game, board, busy: animator.busy || driver.isAiTurn() });
  if (state.phase === PHASES.GAME_OVER) results.show({ rows: computeRanking({ state, board }), state });
  else results.hide();
  if (!animator.busy) autosave();
  scheduleAi();
}

/** 轮到 AI 且动画播完时，延迟一小段再让 AI 走一步 */
function scheduleAi() {
  const current = session;
  if (!current || current.aiTimer || current.animator.busy || !current.driver.isAiTurn()) return;
  current.aiTimer = setTimeout(() => {
    current.aiTimer = null;
    // 期间可能已经开了新局
    if (session !== current || current.animator.busy) return;
    const r = current.driver.step();
    if (r?.fallback) console.warn('AI 改用兜底操作：', r.error);
    if (current.animator.busy) requestFrame();
    else renderPanel();
  }, reducedMotion.matches ? AI_DELAY_MS / 3 : AI_DELAY_MS);
}

/** 用一份状态（新开局或读档）建立对局 */
function startSession(state, intro) {
  if (session?.aiTimer) clearTimeout(session.aiTimer);
  const bus = createEventBus({ onError: (err) => console.error('事件监听器出错', err) });
  const game = createGame({ board, rules: RULES, state, bus, cards: CARDS });
  const fmtCtx = { state, board, cards: CARDS };

  const animator = createAnimator({
    state,
    reducedMotion: reducedMotion.matches,
    onEvent(type, payload) {
      const text = formatEvent(type, payload, fmtCtx);
      if (text) log.add(text, HIGHLIGHT_EVENTS.has(type) ? 'highlight' : 'info');
      const name = EVENT_SOUNDS[type];
      if (name) sound.play(name);
    },
    onChange: requestFrame,
    onIdle: renderPanel,
  });
  bus.on('*', animator.handle);
  const driver = createAiDriver({ game, state, board, rules: RULES });

  session = { state, game, animator, driver, aiTimer: null };
  saveErrorShown = false;
  setup.hide();
  $('game').hidden = false;
  log.clear();
  for (const line of intro) log.add(line, 'highlight');
  resize();
  renderPanel();
  $('actions').querySelector('button')?.focus();
}

/** @param {{ name: string, isAI: boolean, aiLevel?: string }[]} players */
function startGame(players) {
  const seed = (Math.random() * 2 ** 32) >>> 0;
  const state = createInitialState({ board, rules: RULES, cards: CARDS, players, seed });
  startSession(state, [
    `游戏开始：${state.players.map((p) => p.name).join('、')}。每人初始资金 ${RULES.startingCash.toLocaleString('zh-CN')} 元`,
    `第 1 轮 · ${state.players[0].name} 的回合`,
  ]);
}

/** @param {object} state 已通过校验的存档状态 */
function resumeGame(state, savedAt) {
  const when = savedAt ? new Date(savedAt).toLocaleString('zh-CN') : '未知时间';
  const current = state.players[state.currentPlayerIndex];
  const second = state.phase === PHASES.GAME_OVER ? `对局已在第 ${state.round} 轮结束` : `第 ${state.round} 轮 · ${current.name} 的回合`;
  startSession(state, [`已读取存档（${when}）`, second]);
}

/** 当前对局的玩家设置（再来一局用） */
function playerSetupOf(state) {
  return state.players.map((p) => (p.isAI ? { name: p.name, isAI: true, aiLevel: p.aiLevel } : { name: p.name, isAI: false }));
}

function leaveToSetup(options) {
  if (session?.aiTimer) clearTimeout(session.aiTimer);
  session = null;
  results.hide();
  $('game').hidden = true;
  showSetup(options);
}

function downloadSave() {
  if (!session) return;
  const r = exportSave(session.state);
  if (!r.ok) {
    log.add(r.error, 'error');
    return;
  }
  const url = URL.createObjectURL(new Blob([r.text], { type: 'application/json' }));
  const a = document.createElement('a');
  const stamp = new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-');
  a.href = url;
  a.download = `rich-game-${stamp}.json`;
  a.click();
  URL.revokeObjectURL(url);
  log.add('已导出存档文件');
}

/** @param {File} file @returns {Promise<string | null>} 错误信息 */
async function importFile(file) {
  if (file.size > MAX_SAVE_LENGTH) return '存档文件过大';
  let text;
  try {
    text = await file.text();
  } catch {
    return '读取文件失败';
  }
  const r = importSave(text, saveCtx);
  if (!r.ok) {
    if (r.details) console.warn('存档校验失败：', r.details);
    return `导入失败：${r.error}`;
  }
  resumeGame(r.state, r.savedAt);
  return null;
}

/** 按钮 → 逻辑层操作 */
function dispatch(action) {
  if (action.kind === 'newGame') return leaveToSetup();
  if (action.kind === 'rematch') return session && startGame(playerSetupOf(session.state));
  // 动画播放中或 AI 回合，忽略人类操作
  if (!session || session.animator.busy || session.driver.isAiTurn()) return;
  const result = performAction(session.game, action);
  if (!result.ok) {
    log.add(result.error, 'error');
    sound.play('error');
    return;
  }
  if (session.animator.busy) {
    panel.setBusy(true);
  } else {
    // 没有事件要播（理论上不会发生），直接刷新
    renderPanel();
  }
  requestFrame();
}

const panel = createPanel({
  players: $('players'),
  status: $('status'),
  actions: $('actions'),
  assets: $('assets'),
  onAction: dispatch,
});

const setup = createSetup({
  root: $('setup'),
  rules: RULES,
  validate: (players) => validatePlayerSetup(players, RULES),
  onStart: startGame,
  onImport: importFile,
});

/** 显示开局界面；有可用的自动存档时提供“继续上一局” */
function showSetup({ message = '' } = {}) {
  const saved = saveStore.load();
  if (saved === null) return setup.show({ message });

  const checked = saved.ok ? checkLoadedState(saved, saveCtx) : saved;
  if (!checked.ok) {
    if (checked.details) console.warn('自动存档校验失败：', checked.details);
    saveStore.clear();
    return setup.show({ message: `上次的存档无法读取，已删除（${checked.error}）` });
  }
  const { state, savedAt } = checked;
  const names = state.players.map((p) => p.name).join('、');
  const when = savedAt ? new Date(savedAt).toLocaleString('zh-CN') : '';
  setup.show({
    message,
    resume: {
      label: `上一局：${names} · 第 ${state.round} 轮${when ? ` · ${when}` : ''}`,
      onResume: () => resumeGame(state, savedAt),
      onDiscard: () => {
        saveStore.clear();
        setup.show();
      },
    },
  });
}

function resize() {
  const rect = canvas.parentElement.getBoundingClientRect();
  // 画布宽度跟随容器，高宽比固定为 5:8，正好放下等距棋盘
  const width = Math.floor(rect.width);
  renderer.resize(width, Math.floor(width * 0.62));
  canvas.style.width = `${width}px`;
  canvas.style.height = `${Math.floor(width * 0.62)}px`;
  requestFrame();
}

new ResizeObserver(resize).observe(canvas.parentElement);

const muteButton = $('mute');
muteButton.addEventListener('click', () => {
  sound.setMuted(!sound.muted);
  muteButton.setAttribute('aria-pressed', String(!sound.muted));
  muteButton.textContent = sound.muted ? '🔇 声音：关' : '🔊 声音：开';
});
$('export').addEventListener('click', downloadSave);
$('quit').addEventListener('click', () => leaveToSetup());

showSetup();
resize();
