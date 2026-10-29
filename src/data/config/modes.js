/**
 * 数据层：对局模式。每种模式在 RULES 的基础上覆盖部分规则；对局状态里记着 mode，
 * 读档、校验、结算都按这一局的模式取规则。
 */
import { RULES } from './rules.js';

export const MODES = {
  quick: {
    name: '短局',
    blurb: '约 10 分钟。开局每人随机分到 2 块地，租金翻倍；有人总资产达到 30,000 元、打满回合上限或只剩一人时结束。',
    /** 取值来自全 AI 模拟（每种人数 150 局），估计时长都在 9–11 分钟 */
    overrides: {
      startingCash: 8000,
      passStartBonus: 1000,
      rentMultiplier: 2,
      goalNetWorth: 30000,
      startingProperties: 2,
    },
    /** 回合上限随人数变化：人越多每轮越长，轮数相应减少 */
    roundsByPlayers: { 2: 40, 3: 32, 4: 25, 5: 20 },
  },
  classic: {
    name: '经典长局',
    blurb: '经典规则，玩到只剩一人或打满 100 轮。',
    overrides: {},
  },
};

export const DEFAULT_MODE = 'quick';

/**
 * 某模式下的完整规则。
 * @param {string} mode
 * @param {number} [playerCount] 有按人数变化的回合上限时需要
 */
export function rulesFor(mode, playerCount) {
  const m = MODES[mode];
  if (!m) throw new RangeError(`未知对局模式: ${mode}`);
  const rules = { ...RULES, ...m.overrides };
  const rounds = m.roundsByPlayers?.[playerCount];
  if (rounds) rules.maxRounds = rounds;
  return rules;
}
