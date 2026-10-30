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
import { createRecordStore } from './data/save/challengeRecords.js';
import { createBoard } from './logic/core/board.js';
import { createEventBus } from './logic/core/eventBus.js';
import { createInitialState, validatePlayerSetup } from './logic/core/gameState.js';
import { createGame } from './logic/core/game.js';
import { performAction } from './logic/core/actions.js';
import { checkLoadedState, exportSave, importSave } from './logic/core/saveGame.js';
import { challengeScore, computeRanking, isBetterScore, isChallengeScore } from './logic/core/results.js';
import {
  challengePlayers,
  dailyChallenge,
  decodeChallenge,
  encodeChallenge,
  localDateKey,
  seatKinds,
} from './logic/systems/challenge.js';
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
import { createLobby } from './view/ui/lobby.js';
import { connect } from './view/net/client.js';

const $ = (id) => document.getElementById(id);
$('favicon').setAttribute('href', faviconHref());

const board = createBoard({ tiles: TILES, groups: GROUPS, rules: RULES });
const saveCtx = { board, rules: RULES, cards: CARDS };
const canvas = /** @type {HTMLCanvasElement} */ ($('board'));
const renderer = createBoardRenderer(canvas);
const sound = createSound();
const results = createResults($('results'), { onReplay: (code) => startCode(code) });
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
const records = createRecordStore(getStorage());

/** 本机记录的某个挑战码最好成绩，记录损坏时当作没有 */
function bestScore(code) {
  const r = records.get(code);
  return isChallengeScore(r) ? r : null;
}

/**
 * 终局时的挑战信息。每局只算一次并只写一次记录，之后重绘结算表都用这次的结果。
 * @returns {object | null}
 */
function challengeView(current) {
  const { state } = current;
  if (!state.challenge) return null;
  if (current.challengeView) return current.challengeView;
  // 联网对局只显示挑战码，不记本机成绩（成绩按本机第一位人类玩家算，联网时不适用）
  if (current.online) {
    current.challengeView = { ...state.challenge, score: null, best: null, newBest: false };
    return current.challengeView;
  }
  const score = challengeScore({ state, board });
  const best = bestScore(state.challenge.code);
  const newBest = score !== null && isBetterScore(score, best);
  if (newBest) records.set(state.challenge.code, score);
  current.challengeView = { ...state.challenge, score, best, newBest };
  return current.challengeView;
}

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

/** 联网对局里现在不该自己操作：轮到别人 */
const notMyTurn = (s) => Boolean(s.online) && s.game.actingPlayerId() !== s.online.me;

function renderPanel() {
  if (!session) return;
  const { state, game, animator, driver, online } = session;
  // AI 回合中、联网时轮到别人时，人类按钮全部禁用
  panel.render({ state, game, board, busy: animator.busy || driver.isAiTurn() || notMyTurn(session), rules: session.rules, me: online?.me ?? null });
  if (state.phase === PHASES.GAME_OVER) results.show({ rows: computeRanking({ state, board }), state, challenge: challengeView(session) });
  else results.hide();
  if (!animator.busy) {
    // 联网对局存在服务器上；动画播完告诉服务器，服务器等大家都看完再继续
    if (!online) autosave();
    else if (online.acked < online.seq) {
      online.acked = online.seq;
      net?.conn.send({ t: 'ready', seq: online.seq });
    }
  }
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

/**
 * 用一份状态（新开局、读档或联网）建立对局。
 * @param {object} state
 * @param {string[]} intro 开局日志
 * @param {{ me: string } | null} [online] 联网对局：对局在服务器上运行，本机只播放服务器发来的事件
 */
function startSession(state, intro, online = null) {
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
  // 联网时 AI 在服务器上走，本机不驱动任何 AI
  const driver = createAiDriver({ game, state, board, rules, cards: CARDS, ...(online && { controls: () => false }) });

  session = {
    state,
    game,
    bus,
    animator,
    driver,
    rules,
    aiTimer: null,
    challengeView: null,
    /** seq：收到的最新一批；acked：已经告诉服务器播完的一批 */
    online: online && { me: online.me, seq: 0, acked: 0 },
  };
  $('export').disabled = Boolean(online);
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
 * 每一局都带挑战码，结算时可以分享给别人玩同一局。
 * @param {{ name: string, isAI: boolean, aiLevel?: string }[]} players
 * @param {string} [mode]
 * @param {{ seed?: number, daily?: string | null }} [options] 不给 seed 时随机；daily 为每日挑战的日期
 */
function startGame(players, mode = DEFAULT_MODE, { seed = (Math.random() * 2 ** 32) >>> 0, daily = null } = {}) {
  const rules = rulesFor(mode, players.length);
  const code = encodeChallenge({ mode, kinds: seatKinds(players), seed });
  const state = createInitialState({ board, rules, cards: CARDS, players, seed, mode, challenge: { code, daily } });
  const lines = [
    `${MODES[mode].name}开始：${state.players.map((p) => p.name).join('、')}。每人初始资金 ${rules.startingCash.toLocaleString('zh-CN')} 元`,
    daily ? `今日挑战 · 挑战码 ${code}` : `挑战码 ${code}`,
  ];
  if (rules.startingProperties > 0) lines.push(`开局每人随机分到 ${rules.startingProperties} 块地`);
  const ends = [`打满 ${rules.maxRounds} 轮`, '只剩一人'];
  if (rules.goalNetWorth > 0) ends.unshift(`有人总资产达到 ${rules.goalNetWorth.toLocaleString('zh-CN')} 元`);
  lines.push(`结束条件：${ends.join('、')}`, `第 1 轮 · ${state.players[0].name} 的回合`);
  startSession(state, lines);
}

/** 按挑战配置开局 */
function startChallenge({ mode, kinds, seed }, daily = null) {
  startGame(challengePlayers(kinds), mode, { seed, daily });
}

function startDaily() {
  const today = localDateKey(new Date());
  startChallenge(dailyChallenge(today), today);
}

/**
 * 用挑战码开局。今天的每日挑战码也算作每日挑战。
 * @param {string} text
 * @returns {string | null} 错误信息
 */
function startCode(text) {
  const r = decodeChallenge(text);
  if (!r.ok) return r.error;
  const today = localDateKey(new Date());
  startChallenge(r.config, encodeChallenge(dailyChallenge(today)) === r.code ? today : null);
  return null;
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
  $('export').disabled = false;
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
  if (session?.online) {
    if (action.kind === 'newGame') return leaveRoom();
    if (action.kind === 'rematch') return net?.conn.send({ t: 'toLobby' });
  }
  if (action.kind === 'newGame') return leaveToSetup();
  if (action.kind === 'rematch') return session && startGame(playerSetupOf(session.state), session.state.mode);
  // 动画播放中、AI 回合或联网时轮到别人，忽略操作
  if (!session || session.animator.busy || session.driver.isAiTurn() || notMyTurn(session)) return { ok: false, error: '现在不能操作' };
  if (action.kind === 'openTrade') {
    tradeDialog.open({ state: session.state, board, playerId: session.game.actingPlayerId() });
    return;
  }
  if (session.online) {
    // 交给服务器执行，结果随下一条 update 回来；被拒绝时服务器回 error，显示在日志里
    net?.conn.send({ t: 'action', action });
    panel.setBusy(true);
    return { ok: true };
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
  daily: () => {
    const dateKey = localDateKey(new Date());
    return { dateKey, best: bestScore(encodeChallenge(dailyChallenge(dateKey))) };
  },
  onDaily: startDaily,
  onCode: startCode,
  onCreateRoom: (name) => request({ t: 'create', name }),
  onJoinRoom: (code, name) => request({ t: 'join', code, name }),
});

// ---------- 联网房间 ----------

/** 当前的联网连接：conn 为连接，waiting 为等待服务器回应的建房/加入/重连请求，me 为对局里自己的玩家 id */
let net = null;

/**
 * 断线重连用的房间码和令牌。存在 sessionStorage：只属于这个标签页，刷新后还在，
 * 同一台电脑开两个标签页各坐一个座位时互不覆盖。读写失败时就是不能自动重连。
 */
const SEAT_KEY = 'rich-game:online-seat';
function loadSeat() {
  try {
    const v = JSON.parse(window.sessionStorage.getItem(SEAT_KEY) ?? 'null');
    return v && typeof v.code === 'string' && typeof v.token === 'string' ? v : null;
  } catch {
    return null;
  }
}
function saveSeat(seat) {
  try {
    if (seat) window.sessionStorage.setItem(SEAT_KEY, JSON.stringify(seat));
    else window.sessionStorage.removeItem(SEAT_KEY);
  } catch {
    // 存不下只影响刷新后能否自动回到座位
  }
}
/** 断线后自动重连：每次间隔、最多次数 */
const RECONNECT_MS = 2000;
const RECONNECT_TRIES = 15;

const lobby = createLobby({ root: $('lobby'), send: (msg) => net?.conn.send(msg), onLeave: leaveRoom });

/** 收到服务器消息 */
function onNetMessage(msg) {
  // 只有这几种消息是对建房/加入/重连请求的回应
  const waiting = ['room', 'error', 'resumeFailed'].includes(msg.t) ? net?.waiting : null;
  if (waiting) net.waiting = null;
  if (msg.t === 'joined') {
    saveSeat({ code: String(msg.code), token: String(msg.token) });
  } else if (msg.t === 'left') {
    saveSeat(null);
  } else if (msg.t === 'resumeFailed') {
    saveSeat(null);
    if (waiting) waiting(String(msg.message));
  } else if (msg.t === 'room') {
    waiting?.(null);
    // 对局结束、房主带大家回到房间
    if (session?.online && msg.room.phase === 'lobby') endOnlineSession();
    // 对局中其他人进出时房间也会更新，只在大厅里显示；重连回到对局时等接下来的 update
    if (session?.online || msg.room.phase === 'playing') return;
    setup.hide();
    lobby.setRoom(msg.room);
  } else if (msg.t === 'error') {
    if (waiting) waiting(String(msg.message));
    else if (session?.online) {
      log.add(String(msg.message), 'error');
      sound.play('error');
      renderPanel();
    } else lobby.showError(String(msg.message));
  } else if (msg.t === 'started') {
    if (net) net.me = String(msg.you);
  } else if (msg.t === 'update') {
    applyUpdate(msg);
  }
}

/** 收到服务器的一批事件和最新状态：第一批时建立对局，之后原地替换状态并播放事件 */
function applyUpdate(msg) {
  if (!net?.me || !msg.state || typeof msg.state !== 'object' || !Array.isArray(msg.events)) return;
  if (!session?.online) {
    lobby.hide();
    const names = msg.state.players.map((p) => p.name).join('、');
    startSession(msg.state, [`联网对局开始：${names}`, `${MODES[msg.state.mode]?.name ?? ''} · 挑战码 ${msg.state.challenge?.code ?? '无'}`], { me: net.me });
  } else {
    // 对局、动画、面板都拿着同一个 state 对象，所以原地替换内容
    const { state } = session;
    for (const key of Object.keys(state)) delete state[key];
    Object.assign(state, msg.state);
  }
  session.online.seq = msg.seq;
  if (msg.notice) log.add(String(msg.notice), 'highlight');
  // 交易框开着时轮次已经过去（超时由 AI 代走等）：关掉，免得提交一笔过时的交易
  const { state, game } = session;
  if (tradeDialog.isOpen && !(state.phase === PHASES.AWAIT_ROLL && game.actingPlayerId() === session.online.me)) {
    tradeDialog.close();
    log.add('已经不是你的掷骰阶段，交易框已关闭', 'error');
  }
  for (const [type, payload] of msg.events) session.bus.emit(type, payload);
  if (document.hidden) catchUp();
  if (session.animator.busy) {
    panel.setBusy(true);
    requestFrame();
  } else renderPanel();
}

/**
 * 页面在后台时浏览器暂停 requestAnimationFrame，动画永远播不完，服务器会一直等这位玩家。
 * 联网对局里此时直接播完排队的动画（日志照常写入），回到前台时看到的是最新局面。
 */
function catchUp() {
  if (session?.online) session.animator.skipAll();
}
document.addEventListener('visibilitychange', () => {
  if (document.hidden) catchUp();
  else requestFrame();
});

function onNetClose(reason, canRetry) {
  const waiting = net?.waiting;
  net = null;
  if (waiting) return waiting(reason);
  if (canRetry && loadSeat()) return reconnect(reason);
  if (!canRetry) saveSeat(null);
  closeOnline(reason);
}

/** 不再联网：回到开局界面并显示原因 */
function closeOnline(message) {
  lobby.hide();
  if (session?.online) leaveToSetup({ message });
  else showSetup({ message });
}

/** 网络断了：保留画面，每隔一会儿凭令牌重连，连上后服务器发来最新局面 */
async function reconnect(reason) {
  if (session?.online) log.add(`${reason}，正在重连……`, 'error');
  else lobby.showNotice(`${reason}，正在重连……`);
  for (let i = 0; i < RECONNECT_TRIES; i++) {
    await new Promise((r) => setTimeout(r, RECONNECT_MS));
    const seat = loadSeat();
    if (!seat || net) return;
    const error = await request({ t: 'resume', ...seat });
    if (!error) {
      if (session?.online) log.add('已重新连上', 'highlight');
      else lobby.showNotice('');
      return;
    }
    // 令牌已经无效（房间关了、座位没了）就不用再试
    if (!loadSeat()) return closeOnline(error);
    net?.conn.close();
    net = null;
  }
  saveSeat(null);
  closeOnline('一直连不上服务器，已退出联网对局');
}

/**
 * 发出建房或加入请求，等服务器回应。
 * @returns {Promise<string | null>} 错误信息
 */
async function request(msg) {
  if (!net) {
    try {
      net = { conn: await connect({ onMessage: onNetMessage, onClose: onNetClose }), waiting: null };
    } catch (err) {
      return err.message;
    }
  }
  return new Promise((resolve) => {
    net.waiting = resolve;
    net.conn.send(msg);
  });
}

/** 离开联网对局的画面（不离开房间） */
function endOnlineSession() {
  tradeDialog.close();
  session = null;
  results.hide();
  $('game').hidden = true;
  $('export').disabled = false;
}

function leaveRoom() {
  saveSeat(null);
  if (net) {
    net.conn.send({ t: 'leave' });
    net.conn.close();
    net = null;
  }
  lobby.hide();
  if (session?.online) endOnlineSession();
  showSetup();
}

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
$('quit').addEventListener('click', () => (session?.online ? leaveRoom() : leaveToSetup()));

// 刷新前在联网房间里的话，凭令牌回到原来的座位
const savedSeat = loadSeat();
if (savedSeat) {
  request({ t: 'resume', ...savedSeat }).then((error) => {
    if (!error) return;
    net?.conn.close();
    net = null;
    saveSeat(null);
    showSetup({ message: `没能回到联网房间：${error}` });
  });
} else showSetup();
resize();
