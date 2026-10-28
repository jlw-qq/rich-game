/**
 * 逻辑层：玩家移动与入狱。
 */

/**
 * @typedef {{
 *   state: { players: object[] },
 *   board: { size: number, tiles: readonly object[], advance: Function },
 *   rules: { passStartBonus: number },
 *   bus: { emit: (type: string, payload?: object) => void },
 * }} Context
 */

function findPlayer(state, playerId) {
  const player = state.players.find((p) => p.id === playerId);
  if (!player) throw new RangeError(`玩家不存在: ${playerId}`);
  return player;
}

/**
 * 移动 steps 格。正数前进，负数后退。每经过起点一次发一次奖励。
 * playerMoved 事件带逐格路径 path（不含起点格），供表现层做逐格动画。
 * @param {Context} ctx
 * @param {string} playerId
 * @param {number} steps
 * @returns {{ position: number, laps: number }}
 */
export function movePlayer({ state, board, rules, bus }, playerId, steps) {
  const player = findPlayer(state, playerId);
  const from = player.position;
  const { position, laps } = board.advance(from, steps);

  const sign = Math.sign(steps);
  const path = Array.from({ length: Math.abs(steps) }, (_, i) => board.advance(from, sign * (i + 1)).position);

  player.position = position;
  bus.emit('playerMoved', { playerId, from, to: position, steps, path });

  if (laps > 0) {
    const amount = laps * rules.passStartBonus;
    player.cash += amount;
    bus.emit('passedStart', { playerId, laps, amount });
  }
  return { position, laps };
}

/**
 * 直接送进监狱：不经过起点、不发奖励。
 * @param {Context} ctx
 * @param {string} playerId
 */
export function sendToJail({ state, board, bus }, playerId) {
  const player = findPlayer(state, playerId);
  // 校验器保证监狱格恰好 1 个
  const jailIndex = board.tiles.findIndex((t) => t.type === 'jail');
  const from = player.position;
  player.position = jailIndex;
  player.inJail = true;
  player.jailTurns = 0;
  bus.emit('sentToJail', { playerId, from, to: jailIndex });
}
