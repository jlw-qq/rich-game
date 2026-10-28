/**
 * 数据层：机会卡与命运卡。金额单位：元。
 * effect.type：
 *   gain            从银行获得 amount
 *   pay             付给银行 amount
 *   collectFromEach 每位其他玩家付给你 amount（对方现金不足时只付现有现金）
 *   payEach         你付给每位其他玩家 amount
 *   move            移动 steps 格（负数为后退）
 *   moveTo          前进到 tileId（经过起点照常领奖）
 *   goToJail        直接入狱
 *   jailFree        出狱卡，持有期间不在牌堆中
 *   repairs         按名下建筑总等级，每级付给银行 perLevel
 */

const card = (deck, id, title, text, effect) => ({ id, deck, title, text, effect });
const chance = (...args) => card('chance', ...args);
const fate = (...args) => card('fate', ...args);

export const CARDS = [
  chance('c-advance-start', '直达起点', '前进到起点，领取奖励。', { type: 'moveTo', tileId: 'start' }),
  chance('c-to-beijing', '进京赶考', '前进到北京。', { type: 'moveTo', tileId: 'beijing' }),
  chance('c-to-wuhan', '长江游轮', '前进到武汉。', { type: 'moveTo', tileId: 'wuhan' }),
  chance('c-to-hangzhou', '西湖之旅', '前进到杭州。', { type: 'moveTo', tileId: 'hangzhou' }),
  chance('c-back-3', '走错路口', '后退 3 格。', { type: 'move', steps: -3 }),
  chance('c-forward-5', '顺风车', '前进 5 格。', { type: 'move', steps: 5 }),
  chance('c-go-jail', '违章被捕', '直接入狱，不经过起点。', { type: 'goToJail' }),
  chance('c-jail-free', '出狱许可', '保留此卡，可用于免费出狱。', { type: 'jailFree' }),
  chance('c-dividend', '银行分红', '获得 500 元。', { type: 'gain', amount: 500 }),
  chance('c-speeding', '超速罚款', '支付 300 元。', { type: 'pay', amount: 300 }),
  chance('c-repairs', '房屋大修', '每级建筑支付 250 元维修费。', { type: 'repairs', perLevel: 250 }),
  chance('c-chairman', '当选董事长', '向每位玩家支付 500 元。', { type: 'payEach', amount: 500 }),
  chance('c-loan', '贷款到期', '获得 1500 元。', { type: 'gain', amount: 1500 }),
  chance('c-lottery', '彩票中奖', '获得 1000 元。', { type: 'gain', amount: 1000 }),

  fate('f-advance-start', '回到原点', '前进到起点，领取奖励。', { type: 'moveTo', tileId: 'start' }),
  fate('f-bank-error', '银行出错', '银行算错账，获得 2000 元。', { type: 'gain', amount: 2000 }),
  fate('f-doctor', '看病', '支付医药费 500 元。', { type: 'pay', amount: 500 }),
  fate('f-stock', '股票分红', '获得 500 元。', { type: 'gain', amount: 500 }),
  fate('f-jail-free', '保释令', '保留此卡，可用于免费出狱。', { type: 'jailFree' }),
  fate('f-go-jail', '误入歧途', '直接入狱，不经过起点。', { type: 'goToJail' }),
  fate('f-birthday', '生日快乐', '每位玩家送你 100 元。', { type: 'collectFromEach', amount: 100 }),
  fate('f-tax-refund', '退税', '获得 200 元。', { type: 'gain', amount: 200 }),
  fate('f-hospital', '住院', '支付住院费 1000 元。', { type: 'pay', amount: 1000 }),
  fate('f-school', '学费', '支付学费 500 元。', { type: 'pay', amount: 500 }),
  fate('f-consult', '咨询费', '获得 250 元。', { type: 'gain', amount: 250 }),
  fate('f-street-repairs', '道路维修', '每级建筑支付 400 元。', { type: 'repairs', perLevel: 400 }),
  fate('f-contest', '选美亚军', '获得 100 元。', { type: 'gain', amount: 100 }),
  fate('f-inherit', '继承遗产', '获得 1000 元。', { type: 'gain', amount: 1000 }),
];
