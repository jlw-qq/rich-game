/**
 * 逻辑层：棋盘查询。由配置构建只读棋盘，构建时校验配置。
 */
import { validateBoard, validateRules } from './boardValidator.js';

export class BoardConfigError extends Error {
  /** @param {string[]} errors */
  constructor(errors) {
    super(`棋盘配置无效:\n- ${errors.join('\n- ')}`);
    this.name = 'BoardConfigError';
    this.errors = errors;
  }
}

function deepFreeze(obj) {
  for (const value of Object.values(obj)) {
    if (value && typeof value === 'object') deepFreeze(value);
  }
  return Object.freeze(obj);
}

/**
 * @param {{ tiles: object[], groups: Record<string, unknown>, rules: Record<string, unknown> }} config
 */
export function createBoard({ tiles, groups, rules }) {
  // 规则不合法时 maxLevel 等字段不可信，先单独报错
  const ruleErrors = validateRules(rules);
  const errors = ruleErrors.length > 0 ? ruleErrors : validateBoard(tiles, groups, rules);
  if (errors.length > 0) throw new BoardConfigError(errors);

  // 拷贝后冻结，外部改动原配置不会影响已构建的棋盘
  const boardTiles = deepFreeze(structuredClone(tiles));
  const size = boardTiles.length;
  const tilesByGroup = new Map(
    Object.keys(groups).map((g) => [
      g,
      Object.freeze(boardTiles.filter((t) => t.type === 'property' && t.group === g)),
    ]),
  );

  function assertIndex(index) {
    if (!Number.isInteger(index) || index < 0 || index >= size) {
      throw new RangeError(`格子下标越界: ${index}（有效范围 0–${size - 1}）`);
    }
  }

  /** @param {number} index */
  function getTile(index) {
    assertIndex(index);
    return boardTiles[index];
  }

  /**
   * 从 position 移动 steps 格。正数前进，负数后退（后退不算经过起点）。
   * laps 为经过起点的次数，正好停在起点也算一次。
   * @param {number} position
   * @param {number} steps
   * @returns {{ position: number, laps: number, passedStart: boolean }}
   */
  function advance(position, steps) {
    assertIndex(position);
    if (!Number.isInteger(steps)) throw new RangeError(`步数必须是整数: ${steps}`);
    const target = position + steps;
    const laps = steps > 0 ? Math.floor(target / size) : 0;
    return { position: ((target % size) + size) % size, laps, passedStart: laps > 0 };
  }

  /** @param {string} group */
  function getGroupTiles(group) {
    const list = tilesByGroup.get(group);
    if (!list) throw new RangeError(`未知颜色组: ${group}`);
    return list;
  }

  return Object.freeze({ size, tiles: boardTiles, getTile, advance, getGroupTiles });
}
