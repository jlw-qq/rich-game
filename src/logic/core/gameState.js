/**
 * 逻辑层：游戏状态。状态只含纯数据（可 JSON 序列化），便于存档与回放。
 */
import { PHASES } from './turnMachine.js';
import { createRng } from '../utils/rng.js';
import { buildDecks, validateCards } from '../systems/cards.js';

/** 版本 2：新增交易（pendingTrade、tradesThisTurn） */
export const STATE_VERSION = 2;
export const MAX_NAME_LENGTH = 12;
/** AI 难度 */
export const AI_LEVELS = ['easy', 'normal'];

export class GameSetupError extends Error {
  /** @param {string[]} errors */
  constructor(errors) {
    super(`开局参数无效:\n- ${errors.join('\n- ')}`);
    this.name = 'GameSetupError';
    this.errors = errors;
  }
}

/**
 * @param {unknown} players
 * @param {{ minPlayers: number, maxPlayers: number }} rules
 * @returns {string[]}
 */
export function validatePlayerSetup(players, rules) {
  if (!Array.isArray(players)) return ['玩家列表必须是数组'];

  const errors = [];
  const { minPlayers, maxPlayers } = rules;
  if (players.length < minPlayers || players.length > maxPlayers) {
    errors.push(`玩家人数必须在 ${minPlayers}–${maxPlayers} 之间，实际 ${players.length} 人`);
  }

  const seen = new Set();
  players.forEach((p, i) => {
    const where = `玩家[${i}]`;
    const name = typeof p?.name === 'string' ? p.name.trim() : '';
    if (name === '') errors.push(`${where} 名字不能为空`);
    else if ([...name].length > MAX_NAME_LENGTH) errors.push(`${where} 名字不能超过 ${MAX_NAME_LENGTH} 个字`);
    else if (seen.has(name)) errors.push(`${where} 名字重复: ${name}`);
    else seen.add(name);

    if (p?.isAI !== undefined && typeof p.isAI !== 'boolean') errors.push(`${where} isAI 必须是布尔值`);
    if (p?.aiLevel !== undefined && !AI_LEVELS.includes(p.aiLevel)) {
      errors.push(`${where} aiLevel 必须是 ${AI_LEVELS.join(' / ')}，实际为 ${p.aiLevel}`);
    }
  });
  return errors;
}

/**
 * @param {{
 *   board: { tiles: readonly object[] },
 *   rules: { startingCash: number, minPlayers: number, maxPlayers: number },
 *   players: { name: string, isAI?: boolean }[],
 *   seed: number,
 * }} options
 */
export function createInitialState({ board, rules, players, seed, cards = [] }) {
  const errors = validatePlayerSetup(players, rules);
  if (!Number.isInteger(seed)) errors.push(`seed 必须是整数，实际为 ${seed}`);
  errors.push(...validateCards(cards, board));
  if (errors.length > 0) throw new GameSetupError(errors);

  // 洗牌和骰子共用同一条随机序列，开局洗完后把状态交给骰子
  const rng = createRng(seed);
  const decks = buildDecks(cards, rng);

  return {
    version: STATE_VERSION,
    phase: PHASES.AWAIT_ROLL,
    /** 累计行动回合数（每位玩家行动一次算一回合），从 1 开始 */
    turn: 1,
    /** 轮数：所有存活玩家各行动一次为一轮，从 1 开始 */
    round: 1,
    currentPlayerIndex: 0,
    /** 当前玩家本回合连续掷出双数的次数，换人时清零 */
    doublesCount: 0,
    players: players.map((p, i) => ({
      id: `p${i + 1}`,
      name: p.name.trim(),
      isAI: p.isAI ?? false,
      /** AI 难度，人类玩家为 null */
      aiLevel: p.isAI ? (p.aiLevel ?? 'normal') : null,
      cash: rules.startingCash,
      position: 0,
      bankrupt: false,
      /** 第几个破产（1 起），未破产为 null */
      bankruptOrder: null,
      inJail: false,
      jailTurns: 0,
      /** 持有的出狱卡 id，用掉后放回原牌堆 */
      jailFreeCards: [],
    })),
    /** 地产归属，key 为格子 id */
    properties: Object.fromEntries(
      board.tiles
        .filter((t) => t.type === 'property')
        .map((t) => [t.id, { ownerId: null, level: 0, mortgaged: false }]),
    ),
    /** 未付清的欠款：{ debtorId, creditorId（null 表示银行）, amount, reason } */
    pendingDebt: null,
    /** 等待答复的交易：{ fromId, toId, give, take }，见 systems/trade.js */
    pendingTrade: null,
    /** 当前玩家本回合已发起的交易次数，换人时清零 */
    tradesThisTurn: 0,
    /** 牌堆：卡牌 id 数组，从头抽 */
    decks,
    rngState: rng.getState(),
    /** AI 决策用的随机数状态，与骰子分开，存档后 AI 的选择也能复现 */
    aiRngState: (seed ^ 0x9e3779b9) >>> 0,
    winnerId: null,
    /** 终局原因：'bankruptcy' | 'roundLimit' */
    endReason: null,
  };
}

/**
 * 把旧版本的对局数据升级到当前版本。返回新对象，不修改参数；无法识别的数据原样返回，交给校验器拒绝。
 * @param {unknown} state
 */
export function migrateState(state) {
  if (!state || typeof state !== 'object' || Array.isArray(state)) return state;
  if (state.version === 1) {
    return { ...state, version: 2, pendingTrade: null, tradesThisTurn: 0 };
  }
  return state;
}
