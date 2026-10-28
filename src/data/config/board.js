/**
 * 数据层：棋盘格子配置。40 格环形，每边 11 格（含四角），布局参照经典大富翁。
 * 只放纯数据，校验与查询在 logic/core。金额单位：元。
 */

/** 地产颜色组（显示颜色属于表现层） */
export const GROUPS = {
  brown: { name: '棕色组' },
  lightBlue: { name: '浅蓝组' },
  pink: { name: '粉色组' },
  orange: { name: '橙色组' },
  red: { name: '红色组' },
  yellow: { name: '黄色组' },
  green: { name: '绿色组' },
  darkBlue: { name: '深蓝组' },
};

/**
 * 地产格。rent[0] 为空地租金，rent[1..4] 为对应等级租金。
 * @param {string} id
 * @param {string} name
 * @param {keyof typeof GROUPS} group
 * @param {number} price
 * @param {number} upgradeCost
 * @param {number[]} rent
 */
const property = (id, name, group, price, upgradeCost, rent) => ({
  type: 'property',
  id,
  name,
  group,
  price,
  upgradeCost,
  rent,
  mortgageValue: price / 2,
});

const chance = (n) => ({ type: 'chance', id: `chance-${n}`, name: '机会' });
const fate = (n) => ({ type: 'fate', id: `fate-${n}`, name: '命运' });

export const TILES = [
  { type: 'start', id: 'start', name: '起点' },
  property('xining', '西宁', 'brown', 600, 500, [20, 100, 300, 900, 1600]),
  fate(1),
  property('yinchuan', '银川', 'brown', 600, 500, [40, 200, 600, 1800, 3200]),
  { type: 'tax', id: 'tax-income', name: '个人所得税', amount: 2000 },
  chance(1),
  property('lanzhou', '兰州', 'lightBlue', 1000, 500, [60, 300, 900, 2700, 4000]),
  chance(2),
  property('huhehaote', '呼和浩特', 'lightBlue', 1000, 500, [60, 300, 900, 2700, 4000]),
  property('taiyuan', '太原', 'lightBlue', 1200, 500, [80, 400, 1000, 3000, 4500]),

  { type: 'jail', id: 'jail', name: '监狱 / 探监' },
  property('nanning', '南宁', 'pink', 1400, 1000, [100, 500, 1500, 4500, 6250]),
  fate(2),
  property('kunming', '昆明', 'pink', 1400, 1000, [100, 500, 1500, 4500, 6250]),
  property('guiyang', '贵阳', 'pink', 1600, 1000, [120, 600, 1800, 5000, 7000]),
  fate(3),
  property('changsha', '长沙', 'orange', 1800, 1000, [140, 700, 2000, 5500, 7500]),
  fate(4),
  property('nanchang', '南昌', 'orange', 1800, 1000, [140, 700, 2000, 5500, 7500]),
  property('hefei', '合肥', 'orange', 2000, 1000, [160, 800, 2200, 6000, 8000]),

  { type: 'parking', id: 'parking', name: '免费停车场' },
  property('wuhan', '武汉', 'red', 2200, 1500, [180, 900, 2500, 7000, 8750]),
  chance(3),
  property('zhengzhou', '郑州', 'red', 2200, 1500, [180, 900, 2500, 7000, 8750]),
  property('xian', '西安', 'red', 2400, 1500, [200, 1000, 3000, 7500, 9250]),
  chance(4),
  property('chengdu', '成都', 'yellow', 2600, 1500, [220, 1100, 3300, 8000, 9750]),
  property('chongqing', '重庆', 'yellow', 2600, 1500, [220, 1100, 3300, 8000, 9750]),
  chance(5),
  property('tianjin', '天津', 'yellow', 2800, 1500, [240, 1200, 3600, 8500, 10250]),

  { type: 'goToJail', id: 'go-to-jail', name: '入狱' },
  property('nanjing', '南京', 'green', 3000, 2000, [260, 1300, 3900, 9000, 11000]),
  property('suzhou', '苏州', 'green', 3000, 2000, [260, 1300, 3900, 9000, 11000]),
  fate(5),
  property('hangzhou', '杭州', 'green', 3200, 2000, [280, 1500, 4500, 10000, 12000]),
  fate(6),
  chance(6),
  property('shanghai', '上海', 'darkBlue', 3500, 2000, [350, 1750, 5000, 11000, 13000]),
  { type: 'tax', id: 'tax-luxury', name: '奢侈品税', amount: 1000 },
  property('beijing', '北京', 'darkBlue', 4000, 2000, [500, 2000, 6000, 14000, 17000]),
].map((tile, index) => ({ index, ...tile }));
