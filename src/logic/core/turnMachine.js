/**
 * 逻辑层：回合状态机。只负责阶段流转、切换玩家和终局判定，具体规则由各 system 驱动。
 * 非法操作返回 { ok: false, error }，状态保持不变；合法操作返回 { ok: true }。
 */

export const PHASES = Object.freeze({
  AWAIT_ROLL: 'awaitRoll',
  /** 当前玩家掷骰前发起了交易，等待对方接受或拒绝 */
  AWAIT_TRADE: 'awaitTrade',
  MOVING: 'moving',
  TILE_EVENT: 'tileEvent',
  AWAIT_DECISION: 'awaitDecision',
  /** 欠款未付清，玩家需变现资产后还款或宣告破产 */
  AWAIT_PAYMENT: 'awaitPayment',
  SETTLE: 'settle',
  TURN_END: 'turnEnd',
  GAME_OVER: 'gameOver',
});

const P = PHASES;

/** 正常流程允许的跳转。turnEnd 只能通过 endTurn 离开，gameOver 是终态 */
const TRANSITIONS = Object.freeze({
  // awaitRoll → awaitPayment：坐满回合被强制保释但现金不足
  [P.AWAIT_ROLL]: [P.MOVING, P.AWAIT_PAYMENT, P.AWAIT_TRADE],
  // 对方答复后回到掷骰前
  [P.AWAIT_TRADE]: [P.AWAIT_ROLL],
  [P.MOVING]: [P.TILE_EVENT],
  // tileEvent → moving：卡牌让玩家再次移动
  [P.TILE_EVENT]: [P.AWAIT_DECISION, P.AWAIT_PAYMENT, P.SETTLE, P.MOVING],
  [P.AWAIT_DECISION]: [P.SETTLE],
  // awaitPayment → moving：付清强制保释金后按掷出的点数移动
  [P.AWAIT_PAYMENT]: [P.SETTLE, P.MOVING],
  [P.SETTLE]: [P.TURN_END],
  [P.TURN_END]: [],
  [P.GAME_OVER]: [],
});

/**
 * @param {string} from
 * @param {string} to
 */
export function canTransition(from, to) {
  return TRANSITIONS[from]?.includes(to) ?? false;
}

const ok = () => ({ ok: true });
const fail = (error) => ({ ok: false, error });

/**
 * @param {object} state 由 createInitialState 创建，状态机会就地修改它
 * @param {{ emit: (type: string, payload?: object) => void }} bus
 * @param {{ maxRounds?: number, pickWinner?: () => string | null }} [options]
 *   打满 maxRounds 轮后由 pickWinner 决出胜者
 */
export function createTurnMachine(state, bus, { maxRounds = Infinity, pickWinner = () => null } = {}) {
  /** 强制设置阶段（不查跳转表），仅供破产、终局等内部流程使用 */
  function setPhase(to) {
    const from = state.phase;
    if (from === to) return;
    state.phase = to;
    bus.emit('phaseChanged', { from, to });
  }

  function activePlayers() {
    return state.players.filter((p) => !p.bankrupt);
  }

  function currentPlayer() {
    return state.players[state.currentPlayerIndex] ?? null;
  }

  /**
   * 进入终局。
   * @param {string | null} winnerId
   * @param {'bankruptcy' | 'roundLimit'} reason
   */
  function finishGame(winnerId, reason) {
    if (state.phase === P.GAME_OVER) return fail('游戏已结束');
    state.winnerId = winnerId;
    state.endReason = reason;
    setPhase(P.GAME_OVER);
    bus.emit('gameOver', { winnerId, reason });
    return ok();
  }

  /** 存活玩家不超过 1 人时进入终局。返回是否已终局 */
  function checkGameOver() {
    const alive = activePlayers();
    if (alive.length > 1) return false;
    finishGame(alive[0]?.id ?? null, 'bankruptcy');
    return true;
  }

  /** @param {string} to */
  function transition(to) {
    if (state.phase === P.GAME_OVER) return fail('游戏已结束');
    if (!Object.hasOwn(TRANSITIONS, to)) return fail(`未知阶段: ${to}`);
    if (!canTransition(state.phase, to)) return fail(`不能从 ${state.phase} 进入 ${to}`);
    setPhase(to);
    return ok();
  }

  /** 结束当前回合，切换到下一位未破产玩家 */
  function endTurn() {
    if (state.phase !== P.TURN_END) return fail(`只能在 ${P.TURN_END} 阶段结束回合，当前为 ${state.phase}`);
    if (checkGameOver()) return ok();

    const n = state.players.length;
    const idx = state.currentPlayerIndex;
    // 下标异常时从头找，保证下面的循环有确定起点
    const from = Number.isInteger(idx) && idx >= 0 && idx < n ? idx : -1;
    // 最多找一圈，杜绝死循环
    for (let step = 1; step <= n; step++) {
      const next = (from + step) % n;
      if (!state.players[next].bankrupt) {
        // 下标绕回（或回到自己）表示新一轮开始
        if (next <= from) {
          if (state.round >= maxRounds) return finishGame(pickWinner(), 'roundLimit');
          state.round += 1;
        }
        state.currentPlayerIndex = next;
        state.turn += 1;
        setPhase(P.AWAIT_ROLL);
        bus.emit('turnStarted', { playerId: state.players[next].id, turn: state.turn, round: state.round });
        return ok();
      }
    }
    // checkGameOver 已保证至少 2 名存活玩家，这里只是兜底
    return fail('找不到可行动的玩家');
  }

  /**
   * 标记玩家破产。资产处置在地产系统中完成后再调用此方法。
   * 当前玩家破产则直接进入 turnEnd；只剩 1 人则终局。
   * @param {string} playerId
   */
  function declareBankrupt(playerId) {
    if (state.phase === P.GAME_OVER) return fail('游戏已结束');
    const player = state.players.find((p) => p.id === playerId);
    if (!player) return fail(`玩家不存在: ${playerId}`);
    if (player.bankrupt) return fail(`玩家已破产: ${playerId}`);

    player.bankrupt = true;
    // 第几个破产，用于结算排名（后破产的名次更高）
    player.bankruptOrder = state.players.filter((p) => p.bankrupt).length;
    bus.emit('playerBankrupt', { playerId });
    if (checkGameOver()) return ok();
    if (player === currentPlayer()) setPhase(P.TURN_END);
    return ok();
  }

  /** 跳过本回合剩余流程直接进入 turnEnd（如被送进监狱） */
  function forceTurnEnd() {
    if (state.phase === P.GAME_OVER) return fail('游戏已结束');
    setPhase(P.TURN_END);
    return ok();
  }

  /** 当前玩家再掷一次（双数奖励）：不换人、不增加回合数 */
  function grantExtraRoll() {
    if (state.phase !== P.TURN_END) return fail(`只能在 ${P.TURN_END} 阶段追加掷骰，当前为 ${state.phase}`);
    const player = currentPlayer();
    if (!player || player.bankrupt) return fail('当前玩家不能行动');
    setPhase(P.AWAIT_ROLL);
    bus.emit('extraRollGranted', { playerId: player.id });
    return ok();
  }

  return {
    get phase() {
      return state.phase;
    },
    currentPlayer,
    activePlayers,
    transition,
    endTurn,
    declareBankrupt,
    forceTurnEnd,
    grantExtraRoll,
    finishGame,
  };
}
