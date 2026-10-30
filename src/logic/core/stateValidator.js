/**
 * 逻辑层：校验读档得到的对局状态。存档可能来自旧版本、被手动修改或已损坏，
 * 读档前必须确认结构完整、引用有效、数值在合法范围内，否则拒绝，不让坏数据进入对局。
 */
import { PHASES } from './turnMachine.js';
import { AI_LEVELS, MAX_NAME_LENGTH, STATE_VERSION } from './gameState.js';
import { prepareTrade } from '../systems/trade.js';
import { MODES, rulesFor } from '../../data/config/modes.js';

const isInt = (v) => Number.isInteger(v);
const isNonNegInt = (v) => isInt(v) && v >= 0;
const isUint32 = (v) => isInt(v) && v >= 0 && v <= 0xffffffff;
const isPlainObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

/**
 * @param {unknown} state
 * @param {{ board: { tiles: readonly object[], size: number }, rules: object, cards: object[] }} ctx
 * @returns {string[]} 错误列表，空数组表示通过
 */
export function validateState(state, { board, rules: baseRules, cards }) {
  if (!isPlainObject(state)) return ['对局数据不是对象'];
  const errors = [];
  const err = (msg) => errors.push(msg);
  // 回合上限等规则因模式而异，按这一局的模式校验
  const knownMode = typeof state.mode === 'string' && Object.hasOwn(MODES, state.mode);
  if (!knownMode) err(`未知对局模式: ${state.mode}`);
  const rules = knownMode ? rulesFor(state.mode, Array.isArray(state.players) ? state.players.length : undefined) : baseRules;

  if (state.version !== STATE_VERSION) err(`对局数据版本不兼容: ${state.version}`);
  if (!Object.values(PHASES).includes(state.phase)) err(`未知阶段: ${state.phase}`);
  for (const key of ['turn', 'round']) if (!(isInt(state[key]) && state[key] >= 1)) err(`${key} 必须是正整数`);
  if (isInt(state.round) && state.round > rules.maxRounds) err(`round 超过回合上限 ${rules.maxRounds}`);
  if (!isNonNegInt(state.doublesCount) || state.doublesCount >= rules.maxConsecutiveDoubles) err('doublesCount 越界');
  for (const key of ['rngState', 'aiRngState', 'eventRngState']) if (!isUint32(state[key])) err(`${key} 必须是 32 位无符号整数`);

  // ---- 玩家
  const players = state.players;
  if (!Array.isArray(players) || players.length < rules.minPlayers || players.length > rules.maxPlayers) {
    err(`玩家人数必须在 ${rules.minPlayers}–${rules.maxPlayers} 之间`);
    return errors; // 后面的检查都依赖玩家列表
  }
  const playerIds = new Set();
  const heldCards = [];
  players.forEach((p, i) => {
    const where = `玩家[${i}]`;
    if (!isPlainObject(p)) return err(`${where} 不是对象`);
    if (p.id !== `p${i + 1}`) err(`${where} id 应为 p${i + 1}`);
    playerIds.add(p.id);
    if (typeof p.name !== 'string' || p.name.trim() === '' || [...p.name].length > MAX_NAME_LENGTH) err(`${where} 名字无效`);
    if (typeof p.isAI !== 'boolean') err(`${where} isAI 必须是布尔值`);
    if (p.isAI ? !AI_LEVELS.includes(p.aiLevel) : p.aiLevel !== null) err(`${where} aiLevel 无效`);
    if (!isNonNegInt(p.cash)) err(`${where} 现金必须是非负整数`);
    if (!(isInt(p.position) && p.position >= 0 && p.position < board.size)) err(`${where} 位置越界`);
    if (typeof p.bankrupt !== 'boolean' || typeof p.inJail !== 'boolean') err(`${where} 状态标记无效`);
    if (p.bankrupt ? !(isInt(p.bankruptOrder) && p.bankruptOrder >= 1) : p.bankruptOrder !== null) err(`${where} bankruptOrder 无效`);
    // 坐满回合后强制保释付不起时，jailTurns 会停在 maxJailTurns
    if (!isNonNegInt(p.jailTurns) || p.jailTurns > rules.maxJailTurns) err(`${where} jailTurns 越界`);
    if (!p.inJail && p.jailTurns !== 0) err(`${where} 不在狱中但 jailTurns 不为 0`);
    if (p.bankrupt && p.cash !== 0) err(`${where} 已破产但仍有现金`);
    if (!Array.isArray(p.jailFreeCards)) err(`${where} jailFreeCards 必须是数组`);
    else heldCards.push(...p.jailFreeCards);
  });
  const alive = players.filter((p) => p?.bankrupt === false);
  const orders = players.filter((p) => p?.bankrupt).map((p) => p.bankruptOrder).sort((a, b) => a - b);
  if (orders.some((o, k) => o !== k + 1)) err('破产顺序不连续');

  const idx = state.currentPlayerIndex;
  if (!(isInt(idx) && idx >= 0 && idx < players.length)) err('currentPlayerIndex 越界');
  else if (state.phase !== PHASES.GAME_OVER && players[idx]?.bankrupt && state.phase !== PHASES.TURN_END) {
    err('当前玩家已破产');
  }

  // ---- 地产
  const propTiles = board.tiles.filter((t) => t.type === 'property');
  if (!isPlainObject(state.properties)) {
    err('properties 必须是对象');
  } else {
    const keys = Object.keys(state.properties);
    if (keys.length !== propTiles.length || propTiles.some((t) => !Object.hasOwn(state.properties, t.id))) {
      err('地产列表与棋盘不一致');
    }
    for (const t of propTiles) {
      const prop = state.properties[t.id];
      if (!isPlainObject(prop)) continue;
      const where = `地产 ${t.id}`;
      if (prop.ownerId !== null && !playerIds.has(prop.ownerId)) err(`${where} 地主不存在`);
      else if (prop.ownerId !== null && players.find((p) => p.id === prop.ownerId).bankrupt) err(`${where} 属于已破产玩家`);
      if (!(isInt(prop.level) && prop.level >= 0 && prop.level <= rules.maxLevel)) err(`${where} 等级越界`);
      if (typeof prop.mortgaged !== 'boolean') err(`${where} mortgaged 必须是布尔值`);
      if (prop.ownerId === null && (prop.level !== 0 || prop.mortgaged)) err(`${where} 无主却有建筑或抵押`);
      if (prop.mortgaged && prop.level > 0) err(`${where} 抵押且有建筑`);
    }
  }

  // ---- 牌堆：每张卡恰好出现一次（在牌堆里或在玩家手里）
  const cardIds = cards.map((c) => c.id);
  if (!isPlainObject(state.decks) || !Array.isArray(state.decks.chance) || !Array.isArray(state.decks.fate)) {
    err('牌堆数据无效');
  } else {
    const all = [...state.decks.chance, ...state.decks.fate, ...heldCards];
    const sameMembers = all.length === cardIds.length && [...all].sort().join() === [...cardIds].sort().join();
    if (!sameMembers) err('牌堆里的卡牌与配置不一致');
    for (const deck of ['chance', 'fate']) {
      if (state.decks[deck].some((id) => cards.find((c) => c.id === id)?.deck !== deck)) err(`${deck} 牌堆混入了其他牌堆的卡`);
    }
    const isJailFree = (id) => cards.find((c) => c.id === id)?.effect.type === 'jailFree';
    if (!heldCards.every(isJailFree)) err('玩家手里持有非出狱卡');
  }

  // ---- 欠款
  const debt = state.pendingDebt;
  if (state.phase === PHASES.AWAIT_PAYMENT) {
    if (!isPlainObject(debt)) err('还款阶段缺少欠款数据');
    else {
      if (!playerIds.has(debt.debtorId)) err('欠款人不存在');
      if (!(isInt(debt.amount) && debt.amount > 0)) err('欠款金额无效');
      const creditors = debt.creditorId === null ? [] : [debt.creditorId].flat();
      if (creditors.some((id) => !playerIds.has(id))) err('债主不存在');
    }
  } else if (debt !== null) {
    err('非还款阶段存在欠款');
  }

  // ---- 交易
  if (!(isNonNegInt(state.tradesThisTurn) && state.tradesThisTurn <= rules.maxTradesPerTurn)) err('tradesThisTurn 越界');
  const trade = state.pendingTrade;
  if (state.phase === PHASES.AWAIT_TRADE) {
    const current = isInt(idx) ? players[idx] : null;
    if (!isPlainObject(trade)) err('交易阶段缺少交易数据');
    else if (trade.fromId !== current?.id) err('交易发起人不是当前玩家');
    else if (errors.length === 0) {
      // 地产、玩家数据都合法后，再按交易规则复核（引用的资产必须仍然存在且可交易）
      const checked = prepareTrade({ state, board }, trade);
      if (!checked.ok) err(`交易数据无效：${checked.error}`);
    }
  } else if (trade !== null) {
    err('非交易阶段存在待答复的交易');
  }

  // ---- 城市事件
  const pc = state.pendingChoice;
  if (state.phase === PHASES.AWAIT_CHOICE) {
    const current = isInt(idx) ? players[idx] : null;
    if (!isPlainObject(pc)) err('选择阶段缺少城市事件数据');
    else {
      if (pc.playerId !== current?.id) err('城市事件不属于当前玩家');
      if (cards.find((c) => c.id === pc.cardId)?.effect.type !== 'choice') err('城市事件卡无效');
    }
  } else if (pc !== null) {
    err('非选择阶段存在待选的城市事件');
  }

  // ---- 终局
  if (state.phase === PHASES.GAME_OVER) {
    if (!['bankruptcy', 'roundLimit', 'goal'].includes(state.endReason)) err('终局原因无效');
    if (state.winnerId !== null && !alive.some((p) => p.id === state.winnerId)) err('赢家无效');
  } else {
    if (alive.length < 2) err('未终局但存活玩家不足 2 人');
    if (state.winnerId !== null || state.endReason !== null) err('未终局却有赢家');
  }

  return errors;
}
