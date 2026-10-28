/**
 * 逻辑层：掷骰。随机数状态保存在 state.rngState，读档后骰子序列可以接上。
 */
import { createRng } from '../utils/rng.js';

export const DICE_COUNT = 2;
export const DICE_FACES = 6;

/**
 * @param {{ rngState: number }} state 会更新 rngState
 * @returns {{ dice: number[], total: number, isDouble: boolean }}
 */
export function rollDice(state) {
  const rng = createRng(state.rngState);
  const dice = Array.from({ length: DICE_COUNT }, () => rng.int(1, DICE_FACES));
  state.rngState = rng.getState();
  return {
    dice,
    total: dice.reduce((a, b) => a + b, 0),
    isDouble: dice.every((d) => d === dice[0]),
  };
}
