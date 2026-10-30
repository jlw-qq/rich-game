/**
 * 入口：组装逻辑层与表现层。
 * 依赖方向只允许 main/view -> logic -> data，反向引用由 tests/architecture.test.js 拦截。
 *
 * 数据流：UI 按钮 → game 操作 → 逻辑层同步发事件 → animator 排队逐个播放（日志、音效、动画）
 *        → 全部播完后重绘面板并自动存档。面板数字在动画结束后才更新，避免结果提前剧透。
 */
import { TILES, GROUPS } from './data/config/board.js';
import { RULES } from './data/config/rules.js';
import { DEFAULT_MODE, MODES, rulesFor } from './data/config/modes.js';
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
import { isCompactCard, tileCardInfo } from './view/render/tileCard.js';
import { createPopupDescriber } from './view/render/popup.js';
import { faviconHref } from './view/brand.js';
import { createSound } from './view/audio/sound.js';
import { formatEvent } from './view/ui/format.js';
import { createLog } from './view/ui/log.js';
import { createPanel } from './view/ui/panel.js';
import { createResults } from './view/ui/results.js';
import { createSetup } from './view/ui/setup.js';
import { createTradeDialog } from './view/ui/trade.js';
import { bindBoardPicker, createSelection } from './view/ui/boardPicker.js';
import { createViewport } from './view/render/viewport.js';
import { money } from './view/ui/format.js';
import { createCardPanel } from './view/ui/cardPanel.js';

const $ = (id) => document.getElementById(id);
$('favicon').setAttribute('href', faviconHref());

const board = createBoard({ tiles: TILES, groups: GROUPS, rules: RULES });
const saveCtx = { board, rules: RULES, cards: CARDS };
const canvas = /** @type {HTMLCanvasElement} */ ($('board'));
const renderer = createBoardRenderer(canvas);
const sound = createSound();
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

/** 事件日志的展开状态只是本机偏好，读写失败时默认收起 */
const LOG_EXPANDED_KEY = 'rich-game:log-expanded';
function loadLogExpanded() {
  try {
    return getStorage()?.getItem(LOG_EXPANDED_KEY) === '1';
  } catch {
    return false;
  }
}
const log = createLog($('log'), {
  toggle: /** @type {HTMLButtonElement} */ ($('log-toggle')),
  expanded: loadLogExpanded(),
  onToggle(expanded) {
    try {
      getStorage()?.setItem(LOG_EXPANDED_KEY, expanded ? '1' : '0');
    } catch {
      // 存不下只影响下次打开时的默认状态
    }
  },
});

/** 事件 → 音效 */
const EVENT_SOUNDS = {
  diceRolled: 'dice',
  propertyBought: 'buy',
  propertyUpgraded: 'buy',
  gambleRolled: 'dice',
  tradeAccepted: 'buy',
  passedStart: 'coin',
  cashGained: 'coin',
  paymentMade: 'pay',
  sentToJail: 'jail',
  playerBankrupt: 'jail',
  gameOver: 'win',
};
/** 需要醒目显示的日志 */
const HIGHLIGHT_EVENTS = new Set(['turnStarted', 'playerBankrupt', 'gameOver', 'debtPending', 'tradeProposed', 'choiceOffered', 'gambleRolled']);

/** AI 每步操作之间的间隔（毫秒），按播放倍速缩短 */
const AI_DELAY_MS = 600;
/** 可选的播放倍速，点击按钮依次切换 */
const SPEEDS = [1, 2, 4];
const SPEED_KEY = 'rich-game:speed';

/** 播放倍速只是本机偏好，读写失败时用 1× */
function loadSpeed() {
  try {
    const v = Number(getStorage()?.getItem(SPEED_KEY));
    return SPEEDS.includes(v) ? v : 1;
  } catch {
    return 1;
  }
}
let speed = loadSpeed();

/** 棋盘缩放与平移（只在小画布的触屏设备上使用） */
const viewport = createViewport();
const zoomOutButton = $('zoom-out');
/** 棋盘上的字小到需要侧栏卡片时，允许放大查看 */
const zoomEnabled = () => isCompactCard(renderer.cellHeight);

/** 玩家正在查看的格子（悬停、点选、键盘） */
const selection = createSelection(board.size);
/** 上一次看到的落地次数；有新落点时取消固定查看，让玩家先看到“走到哪儿” */
let seenLandings = 0;
const cardPanel = createCardPanel($('tile-card'));
/** 读屏文字只在内容变化时更新，避免重复朗读 */
let lastReadout = '';

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
  let viewMoving = viewport.tick(now);
  // 放大状态下，镜头跟着正在移动的棋子
  if (viewport.zoomed && animator?.busy) {
    const tok = animator.tokens.get(session.game.currentPlayer()?.id);
    if (tok) {
      const p = renderer.boardPoint(tok.gx, tok.gy);
      viewMoving = viewport.follow(p.x, p.y) || viewMoving;
    }
  }
  zoomOutButton.hidden = !viewport.zoomed;
  updateTouchHint();
  canvas.style.touchAction = viewport.zoomed ? 'none' : '';
  const focus = animator?.focus ?? null;
  if (animator && animator.landings !== seenLandings) {
    seenLandings = animator.landings;
    selection.clear();
  }
  const shown = session ? selection.current(focus?.index ?? null) : null;
  const viewing = shown && shown.source !== 'landing' ? shown.index : null;
  const card = shown ? tileCardInfo({ state: session.state, board, rules: session.rules }, shown.index) : null;
  updateReadout(shown, card);
  // 棋盘中央留给城市景观，地产详情一律显示在侧栏
  cardPanel.render(card, shown?.source === 'landing' ? '落点' : '查看');
  renderer.draw({
    board,
    state: session?.state ?? null,
    tokens: animator?.tokens ?? null,
    dice: animator?.dice ?? null,
    floaters: animator?.floaters ?? [],
    effects: animator?.effects,
    currentPlayerId: session && session.state.phase !== PHASES.GAME_OVER ? (session.game.currentPlayer()?.id ?? null) : null,
    focus,
    viewing,
    maxLevel: RULES.maxLevel,
    popup: animator?.popup ?? null,
    reducedMotion: reducedMotion.matches,
    view: viewport.view,
  });
  if (needMore || viewMoving) requestFrame();
}

/** 触屏提示：只在会放大的小画布上提放大手势；放大后说明如何拖动、缩放和回到全图 */
const TOUCH_HINTS = {
  plain: '点按地产查看详情',
  zoomable: '点按地产查看详情，并放大该区域',
  zoomed: '拖动平移 · 双指缩放 · 点右上角「缩小查看全图」回到全图',
};
let touchHint = '';
function updateTouchHint() {
  const key = viewport.zoomed ? 'zoomed' : zoomEnabled() ? 'zoomable' : 'plain';
  if (key === touchHint) return;
  touchHint = key;
  $('hint-touch').textContent = TOUCH_HINTS[key];
}

/** 把正在查看的格子写成一句话，给读屏软件用（只朗读玩家主动查看的格子） */
function updateReadout(shown, card) {
  let text = '';
  if (shown && shown.source !== 'landing') {
    const tile = board.tiles[shown.index];
    text = card
      ? [
          `${card.name}，售价 ${money(card.price)}`,
          card.mortgaged ? '已抵押，免租' : `${card.owner ? '租金' : '空地租金'} ${money(card.rent)}`,
          card.owner ? `所有者 ${card.owner.name}` : '无主',
          `${card.level} 级`,
        ].join('，')
      : tile.type === 'jail'
        ? '监狱'
        : tile.name;
  }
  if (text === lastReadout) return;
  lastReadout = text;
  $('tile-readout').textContent = text;
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
  panel.render({ state, game, board, busy: animator.busy || driver.isAiTurn(), rules: session.rules });
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
  }, (reducedMotion.matches ? AI_DELAY_MS / 3 : AI_DELAY_MS) / speed);
}

/** 用一份状态（新开局或读档）建立对局 */
function startSession(state, intro) {
  if (session?.aiTimer) clearTimeout(session.aiTimer);
  const bus = createEventBus({ onError: (err) => console.error('事件监听器出错', err) });
  // 规则跟着这一局的模式走（旧存档迁移后为经典模式）
  const rules = rulesFor(state.mode, state.players.length);
  const game = createGame({ board, rules, state, bus, cards: CARDS });
  const fmtCtx = { state, board, cards: CARDS };

  const describe = createPopupDescriber();
  const animator = createAnimator({
    state,
    tileIds: board.tiles.map((t) => t.id),
    describePopup: (type, payload) => describe(type, payload, { state, board, rules, cards: CARDS }),
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
  animator.setSpeed(speed);
  animator.setCalm(state.players.every((p) => p.isAI));
  bus.on('*', animator.handle);
  const driver = createAiDriver({ game, state, board, rules, cards: CARDS });

  session = { state, game, animator, driver, rules, aiTimer: null };
  seenLandings = 0;
  selection.clear();
  selection.setHover(null);
  saveErrorShown = false;
  setup.hide();
  $('game').hidden = false;
  log.clear();
  for (const line of intro) log.add(line, 'highlight');
  resize();
  renderPanel();
  // 窄屏时操作按钮在棋盘下方，聚焦时不要把页面滚走
  $('actions').querySelector('button')?.focus({ preventScroll: true });
}

/**
 * @param {{ name: string, isAI: boolean, aiLevel?: string }[]} players
 * @param {string} [mode]
 */
function startGame(players, mode = DEFAULT_MODE) {
  const seed = (Math.random() * 2 ** 32) >>> 0;
  const rules = rulesFor(mode, players.length);
  const state = createInitialState({ board, rules, cards: CARDS, players, seed, mode });
  const lines = [
    `${MODES[mode].name}开始：${state.players.map((p) => p.name).join('、')}。每人初始资金 ${rules.startingCash.toLocaleString('zh-CN')} 元`,
  ];
  if (rules.startingProperties > 0) lines.push(`开局每人随机分到 ${rules.startingProperties} 块地`);
  const ends = [`打满 ${rules.maxRounds} 轮`, '只剩一人'];
  if (rules.goalNetWorth > 0) ends.unshift(`有人总资产达到 ${rules.goalNetWorth.toLocaleString('zh-CN')} 元`);
  lines.push(`结束条件：${ends.join('、')}`, `第 1 轮 · ${state.players[0].name} 的回合`);
  startSession(state, lines);
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
  tradeDialog.close();
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
  // 部分浏览器在 click 返回后才开始下载，立即释放会导致下载失败
  setTimeout(() => URL.revokeObjectURL(url), 1000);
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

/**
 * 按钮 → 逻辑层操作。
 * @returns {{ ok: boolean, error?: string } | undefined} 逻辑层操作的结果；非逻辑层操作返回 undefined
 */
function dispatch(action) {
  if (action.kind === 'newGame') return leaveToSetup();
  if (action.kind === 'rematch') return session && startGame(playerSetupOf(session.state), session.state.mode);
  // 动画播放中或 AI 回合，忽略人类操作
  if (!session || session.animator.busy || session.driver.isAiTurn()) return { ok: false, error: '现在不能操作' };
  if (action.kind === 'openTrade') {
    tradeDialog.open({ state: session.state, board, playerId: session.game.actingPlayerId() });
    return;
  }
  const result = performAction(session.game, action);
  if (!result.ok) {
    log.add(result.error, 'error');
    sound.play('error');
    return result;
  }
  if (session.animator.busy) {
    panel.setBusy(true);
  } else {
    // 没有事件要播（理论上不会发生），直接刷新
    renderPanel();
  }
  requestFrame();
  return result;
}

const tradeDialog = createTradeDialog({
  root: /** @type {HTMLDialogElement} */ ($('trade')),
  onSubmit: (trade) => {
    const r = dispatch({ kind: 'proposeTrade', trade });
    return r?.ok ? null : (r?.error ?? '现在不能交易');
  },
});

const panel = createPanel({
  players: $('players'),
  status: $('status'),
  actions: $('actions'),
  assets: $('assets'),
  goal: $('goal'),
  onAction: dispatch,
  maxTradesPerTurn: RULES.maxTradesPerTurn,
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
  // 画布宽度跟随容器，高度固定为宽度的 0.62 倍，正好放下等距棋盘
  const width = Math.floor(rect.width);
  renderer.resize(width, Math.floor(width * 0.62));
  viewport.resize(width, Math.floor(width * 0.62));
  canvas.style.width = `${width}px`;
  canvas.style.height = `${Math.floor(width * 0.62)}px`;
  requestFrame();
}

new ResizeObserver(resize).observe(canvas.parentElement);

/**
 * 点棋盘或按任意键提前关掉结果卡。关掉时这次点击或按键只用来关卡片：
 * 不再当作选格子，也不会顺带触发焦点所在的按钮（如 Enter 切换倍速）。
 */
function dismissPopup(e) {
  if (session?.animator.dismissPopup()) {
    e.preventDefault();
    e.stopImmediatePropagation();
    requestFrame();
  }
}
canvas.addEventListener('click', dismissPopup, { capture: true });
document.addEventListener('keydown', (e) => {
  // Tab 用来移动焦点，不拦截
  if (e.key !== 'Tab') dismissPopup(e);
}, { capture: true });

bindBoardPicker({
  canvas,
  selection,
  // 先扣除缩放平移，再按棋盘坐标找格子
  pickTile: (x, y) => {
    const b = viewport.toBoard(x, y);
    return renderer.pickTile(b.x, b.y);
  },
  zoom: { viewport, enabled: zoomEnabled },
  isProperty: (index) => board.tiles[index]?.type === 'property',
  landingIndex: () => session?.animator.focus?.index ?? null,
  onChange: requestFrame,
});

const muteButton = $('mute');
muteButton.addEventListener('click', () => {
  sound.setMuted(!sound.muted);
  muteButton.setAttribute('aria-pressed', String(!sound.muted));
  muteButton.textContent = sound.muted ? '🔇 声音：关' : '🔊 声音：开';
});
const speedButton = $('speed');
function renderSpeed() {
  speedButton.textContent = `⏩ 速度：${speed}×`;
}
speedButton.addEventListener('click', () => {
  speed = SPEEDS[(SPEEDS.indexOf(speed) + 1) % SPEEDS.length];
  session?.animator.setSpeed(speed);
  renderSpeed();
  try {
    getStorage()?.setItem(SPEED_KEY, String(speed));
  } catch {
    // 存不下只影响下次打开时的默认值
  }
});
renderSpeed();

zoomOutButton.addEventListener('click', () => {
  viewport.reset(performance.now());
  requestFrame();
});

$('export').addEventListener('click', downloadSave);
$('quit').addEventListener('click', () => leaveToSetup());

showSetup();
resize();
