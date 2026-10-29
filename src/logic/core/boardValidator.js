/**
 * 逻辑层：棋盘与规则配置校验。返回错误信息数组，空数组表示通过。
 */

export const TILE_TYPES = ['start', 'property', 'chance', 'fate', 'tax', 'jail', 'parking', 'goToJail'];

/** 必须恰好出现一次的格子类型 */
const UNIQUE_TYPES = ['start', 'jail', 'goToJail'];

const isPositiveInt = (v) => Number.isInteger(v) && v > 0;

/**
 * @param {Record<string, unknown>} rules
 * @returns {string[]}
 */
export function validateRules(rules) {
  const errors = [];
  const intKeys = [
    'minPlayers',
    'maxPlayers',
    'startingCash',
    'passStartBonus',
    'maxLevel',
    'jailBail',
    'maxJailTurns',
    'maxConsecutiveDoubles',
    'groupRentMultiplier',
    'maxRounds',
    'maxTradesPerTurn',
  ];
  for (const key of intKeys) {
    if (!isPositiveInt(rules[key])) errors.push(`rules.${key} 必须是正整数，实际为 ${rules[key]}`);
  }
  if (rules.minPlayers < 2) errors.push('rules.minPlayers 至少为 2');
  if (rules.maxPlayers < rules.minPlayers) errors.push('rules.maxPlayers 不能小于 minPlayers');

  const rate = rules.mortgageInterestRate;
  if (typeof rate !== 'number' || !(rate >= 0 && rate < 1)) {
    errors.push(`rules.mortgageInterestRate 必须在 [0, 1) 内，实际为 ${rate}`);
  }
  for (const key of ['goalNetWorth', 'startingProperties']) {
    if (!(Number.isInteger(rules[key]) && rules[key] >= 0)) errors.push(`rules.${key} 必须是非负整数，实际为 ${rules[key]}`);
  }
  const rentMult = rules.rentMultiplier;
  if (typeof rentMult !== 'number' || !(rentMult > 0 && rentMult <= 10)) {
    errors.push(`rules.rentMultiplier 必须在 (0, 10] 内，实际为 ${rentMult}`);
  }
  const sellRate = rules.buildingSellRate;
  if (typeof sellRate !== 'number' || !(sellRate >= 0 && sellRate <= 1)) {
    errors.push(`rules.buildingSellRate 必须在 [0, 1] 内，实际为 ${sellRate}`);
  }
  return errors;
}

/**
 * @param {object[]} tiles
 * @param {Record<string, unknown>} groups
 * @param {{ maxLevel: number }} rules 须先通过 validateRules
 * @returns {string[]}
 */
export function validateBoard(tiles, groups, rules) {
  if (!Array.isArray(tiles) || tiles.length === 0) return ['棋盘格子列表为空'];

  const errors = [];
  const ids = new Set();
  const typeCount = {};
  const groupCount = Object.fromEntries(Object.keys(groups).map((g) => [g, 0]));

  tiles.forEach((tile, i) => {
    const where = `格子[${i}]`;
    if (!tile || typeof tile !== 'object') {
      errors.push(`${where} 不是对象`);
      return;
    }
    if (tile.index !== i) errors.push(`${where} index 应为 ${i}，实际为 ${tile.index}`);

    if (typeof tile.id !== 'string' || tile.id === '') errors.push(`${where} 缺少 id`);
    else if (ids.has(tile.id)) errors.push(`${where} id 重复: ${tile.id}`);
    else ids.add(tile.id);

    if (typeof tile.name !== 'string' || tile.name === '') errors.push(`${where} 缺少 name`);

    if (!TILE_TYPES.includes(tile.type)) {
      errors.push(`${where} 未知类型: ${tile.type}`);
      return;
    }
    typeCount[tile.type] = (typeCount[tile.type] ?? 0) + 1;

    if (tile.type === 'property') {
      errors.push(...validateProperty(tile, where, groups, groupCount, rules));
    } else if (tile.type === 'tax' && !isPositiveInt(tile.amount)) {
      errors.push(`${where} 税额必须是正整数，实际为 ${tile.amount}`);
    }
  });

  for (const type of UNIQUE_TYPES) {
    const n = typeCount[type] ?? 0;
    if (n !== 1) errors.push(`类型 ${type} 必须恰好 1 个，实际 ${n} 个`);
  }
  // 移动逻辑按“越过下标 0”判断经过起点，所以起点必须在 0
  if (tiles[0]?.type !== 'start') errors.push('起点必须位于下标 0');

  for (const [group, n] of Object.entries(groupCount)) {
    if (n < 2) errors.push(`颜色组 ${group} 至少需要 2 块地产，实际 ${n} 块`);
  }
  return errors;
}

function validateProperty(tile, where, groups, groupCount, rules) {
  const errors = [];
  if (!Object.hasOwn(groups, tile.group)) errors.push(`${where} 未知颜色组: ${tile.group}`);
  else groupCount[tile.group]++;

  for (const key of ['price', 'upgradeCost', 'mortgageValue']) {
    if (!isPositiveInt(tile[key])) errors.push(`${where} ${key} 必须是正整数，实际为 ${tile[key]}`);
  }
  if (isPositiveInt(tile.price) && isPositiveInt(tile.mortgageValue) && tile.mortgageValue >= tile.price) {
    errors.push(`${where} 抵押价必须低于购买价`);
  }

  const levels = rules.maxLevel + 1;
  const { rent } = tile;
  if (!Array.isArray(rent) || rent.length !== levels) {
    errors.push(`${where} rent 必须有 ${levels} 档`);
  } else if (!rent.every(isPositiveInt)) {
    errors.push(`${where} rent 每档必须是正整数`);
  } else if (rent.some((v, k) => k > 0 && v <= rent[k - 1])) {
    errors.push(`${where} rent 必须逐级递增`);
  }
  return errors;
}
