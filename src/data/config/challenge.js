/**
 * 数据层：每日挑战与挑战码开局用的配置。
 */

/** 每日挑战：短局，你和 3 个普通 AI。改这里会让所有人当天的挑战一起变 */
export const DAILY_CHALLENGE = {
  mode: 'quick',
  kinds: ['human', 'normal', 'normal', 'normal'],
};

/** 用挑战码开局时按座位取名（挑战码里不带名字） */
export const SEAT_NAMES = ['小红', '小蓝', '小黄', '小绿', '小紫'];
/** 只有一位人类玩家时，人类叫这个名字 */
export const SOLO_HUMAN_NAME = '你';
