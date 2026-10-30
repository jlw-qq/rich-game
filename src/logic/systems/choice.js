/**
 * 逻辑层：城市事件卡的选项。玩家抽到 choice 卡后在两个选项里选一个：
 * 稳妥拿钱、冒险掷骰、或免费升级一块地。
 *
 * 冒险用的骰子来自 state.eventRngState，和移动骰子的随机序列分开：
 * 无论玩家怎么选，之后每次掷骰的点数都不变（挑战码依赖这一点）。
 */
import { createRng } from '../utils/rng.js';
import { ownsFullGroup, rentAt, upgradeBlocker } from './property.js';

/** 两颗骰子点数和 ≥ target 的概率 */
export function chanceAtLeast(target) {
  let hit = 0;
  for (let a = 1; a <= 6; a++) for (let b = 1; b <= 6; b++) if (a + b >= target) hit += 1;
  return hit / 36;
}

/**
 * 免费升级的目标：可以升级的地产里，升一级租金涨得最多的一块（并列时取棋盘上靠前的）。
 * @returns {object | null} 格子；没有可升级的地产时为 null
 */
export function upgradeTarget(ctx, playerId) {
  const { state, board, rules } = ctx;
  let best = null;
  let bestGain = -1;
  for (const tile of board.tiles) {
    if (tile.type !== 'property' || state.properties[tile.id].ownerId !== playerId) continue;
    if (!ownsFullGroup(ctx, playerId, tile.group) || upgradeBlocker(ctx, tile.id)) continue;
    const level = state.properties[tile.id].level;
    const gain = rentAt(tile, level + 1, rules) - rentAt(tile, level, rules);
    if (gain > bestGain) {
      best = tile;
      bestGain = gain;
    }
  }
  return best;
}

/**
 * 卡上各选项现在能不能选，以及给玩家看的说明。
 * @returns {{ label: string, outcome: object, available: boolean, chance: number | null, target: object | null }[]}
 */
export function choiceOptions(ctx, playerId, card) {
  return card.effect.options.map((o) => {
    const { outcome } = o;
    if (outcome.type === 'upgrade') {
      const target = upgradeTarget(ctx, playerId);
      return { ...o, available: target !== null, chance: null, target };
    }
    if (outcome.type === 'gamble') return { ...o, available: true, chance: chanceAtLeast(outcome.target), target: null };
    return { ...o, available: true, chance: null, target: null };
  });
}

/**
 * 执行选中的选项。现金收入、免费升级在这里直接结算；冒险失败要付的钱返回收款计划，由对局协调器处理
 * （可能进入还款阶段）。调用前须确认选项可选。
 * @returns {{ kind: 'done' } | { kind: 'charge', creditorId: null, amount: number }}
 */
export function resolveChoice(ctx, playerId, card, index) {
  const { state, bus } = ctx;
  const player = state.players.find((p) => p.id === playerId);
  const option = choiceOptions(ctx, playerId, card)[index];
  const { outcome } = option;
  const reason = { type: 'card', cardId: card.id };
  bus.emit('choiceMade', { playerId, cardId: card.id, index });

  if (outcome.type === 'gain') {
    player.cash += outcome.amount;
    bus.emit('cashGained', { playerId, amount: outcome.amount, reason });
    return { kind: 'done' };
  }

  if (outcome.type === 'upgrade') {
    const prop = state.properties[option.target.id];
    prop.level += 1;
    bus.emit('propertyUpgraded', { playerId, tileId: option.target.id, level: prop.level, cost: 0, free: true });
    return { kind: 'done' };
  }

  // 冒险：用事件专用的随机序列掷两颗骰子
  const rng = createRng(state.eventRngState);
  const dice = [rng.int(1, 6), rng.int(1, 6)];
  state.eventRngState = rng.getState();
  const total = dice[0] + dice[1];
  const won = total >= outcome.target;
  bus.emit('gambleRolled', { playerId, cardId: card.id, dice, total, target: outcome.target, won, amount: won ? outcome.win : outcome.lose });
  if (won) {
    player.cash += outcome.win;
    bus.emit('cashGained', { playerId, amount: outcome.win, reason });
    return { kind: 'done' };
  }
  return { kind: 'charge', creditorId: null, amount: outcome.lose };
}
