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
 *   choice          城市事件：玩家在 options 里选一个，每个 option.outcome 为
 *                     { type: 'gain', amount }                    稳妥：直接拿钱
 *                     { type: 'gamble', target, win, lose }       冒险：掷两颗骰子，点数和 ≥ target 得 win，否则付 lose
 *                     { type: 'upgrade' }                         免费给一块可升级的地产升一级（没有可升级的地产时不能选）
 */

const card = (deck, id, title, text, effect) => ({ id, deck, title, text, effect });
const chance = (...args) => card('chance', ...args);
const fate = (...args) => card('fate', ...args);
/** 城市事件：稳妥选项 + 另一个选项 */
const choice = (deck, id, title, text, safe, other) =>
  card(deck, id, title, text, { type: 'choice', options: [safe, other] });
const take = (amount) => ({ label: `稳妥：拿 ${amount} 元`, outcome: { type: 'gain', amount } });
const gamble = (label, target, win, lose) => ({ label, outcome: { type: 'gamble', target, win, lose } });
const upgrade = (label) => ({ label, outcome: { type: 'upgrade' } });

export const CARDS = [
  chance('c-advance-start', '直达起点', '前进到起点，领取奖励。', { type: 'moveTo', tileId: 'start' }),
  chance('c-to-beijing', '进京赶考', '前进到北京。', { type: 'moveTo', tileId: 'beijing' }),
  chance('c-to-wuhan', '长江游轮', '前进到武汉。', { type: 'moveTo', tileId: 'wuhan' }),
  chance('c-to-hangzhou', '西湖之旅', '前进到杭州。', { type: 'moveTo', tileId: 'hangzhou' }),
  chance('c-back-3', '走错路口', '后退 3 格。', { type: 'move', steps: -3 }),
  chance('c-forward-5', '顺风车', '前进 5 格。', { type: 'move', steps: 5 }),
  chance('c-go-jail', '违章被捕', '直接入狱，不经过起点。', { type: 'goToJail' }),
  chance('c-jail-free', '出狱许可', '保留此卡，可用于免费出狱。', { type: 'jailFree' }),
  choice('chance', 'c-new-district', '新区招商', '新区开发需要投资人。', take(500), gamble('冒险：投资新区', 7, 2500, 800)),
  chance('c-speeding', '超速罚款', '支付 300 元。', { type: 'pay', amount: 300 }),
  chance('c-repairs', '房屋大修', '每级建筑支付 250 元维修费。', { type: 'repairs', perLevel: 250 }),
  chance('c-chairman', '当选董事长', '向每位玩家支付 500 元。', { type: 'payEach', amount: 500 }),
  choice('chance', 'c-expo', '城市博览会', '博览会想借用你的城市办展。', take(800), upgrade('借展扩建：免费升级一块地')),
  choice('chance', 'c-startup', '创业补贴', '政府发放创业补贴，也可以拿去做大项目。', take(1000), gamble('冒险：投大项目', 8, 4000, 1200)),

  fate('f-advance-start', '回到原点', '前进到起点，领取奖励。', { type: 'moveTo', tileId: 'start' }),
  fate('f-bank-error', '银行出错', '银行算错账，获得 2000 元。', { type: 'gain', amount: 2000 }),
  fate('f-doctor', '看病', '支付医药费 500 元。', { type: 'pay', amount: 500 }),
  choice('fate', 'f-heritage', '古城修缮', '古城修缮完工，游客渐多。', take(300), gamble('冒险：开发文旅', 6, 1500, 600)),
  fate('f-jail-free', '保释令', '保留此卡，可用于免费出狱。', { type: 'jailFree' }),
  fate('f-go-jail', '误入歧途', '直接入狱，不经过起点。', { type: 'goToJail' }),
  fate('f-birthday', '生日快乐', '每位玩家送你 100 元。', { type: 'collectFromEach', amount: 100 }),
  choice('fate', 'f-festival', '城市灯会', '灯会筹办中，可以只拿赞助，也可以包下整条街。', take(500), gamble('冒险：包下整条街', 9, 5000, 1000)),
  fate('f-hospital', '住院', '支付住院费 1000 元。', { type: 'pay', amount: 1000 }),
  fate('f-school', '学费', '支付学费 500 元。', { type: 'pay', amount: 500 }),
  choice('fate', 'f-talent', '人才引进', '一批工程师来到你的城市。', take(1000), upgrade('安家落户：免费升级一块地')),
  fate('f-street-repairs', '道路维修', '每级建筑支付 400 元。', { type: 'repairs', perLevel: 400 }),
  choice('fate', 'f-tourism', '旅游旺季', '旅游旺季到了。', take(400), gamble('冒险：加开旅游专线', 7, 2000, 700)),
  choice('fate', 'f-metro', '地铁开通', '新地铁线经过你的地段。', take(600), upgrade('沿线开发：免费升级一块地')),
];

/**
 * 旧版本存档里已被城市事件替换掉的卡牌 id → 新 id（同一个牌堆、一一对应），读档时迁移。
 */
export const REPLACED_CARD_IDS = {
  'c-dividend': 'c-new-district',
  'c-loan': 'c-expo',
  'c-lottery': 'c-startup',
  'f-stock': 'f-heritage',
  'f-tax-refund': 'f-festival',
  'f-consult': 'f-talent',
  'f-contest': 'f-tourism',
  'f-inherit': 'f-metro',
};
