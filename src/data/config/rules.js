/**
 * 数据层：全局规则常量。金额单位：元。
 */
export const RULES = {
  minPlayers: 2,
  maxPlayers: 5,
  startingCash: 15000,
  /** 经过或停在起点的奖励 */
  passStartBonus: 2000,
  /** 地产最高等级（0 为空地） */
  maxLevel: 4,
  /** 赎回抵押时在抵押价基础上加收的利息比例 */
  mortgageInterestRate: 0.1,
  /** 拥有整个颜色组时，空地租金的倍数 */
  groupRentMultiplier: 2,
  /** 卖建筑时按升级费的该比例退款 */
  buildingSellRate: 0.5,
  /** 保释出狱费用 */
  jailBail: 500,
  /** 最多被关的回合数，超过后强制交保释金出狱 */
  maxJailTurns: 3,
  /** 连续掷出双数达到该次数直接入狱 */
  maxConsecutiveDoubles: 3,
  /** 回合上限（轮数）。超过后按总资产排名决出胜者 */
  maxRounds: 100,
};
