import { describe, it, expect } from 'vitest';
import { TILES, GROUPS } from '../../../src/data/config/board.js';
import { RULES } from '../../../src/data/config/rules.js';
import { createBoard, BoardConfigError } from '../../../src/logic/core/board.js';
import { validateBoard, validateRules } from '../../../src/logic/core/boardValidator.js';

const clone = () => structuredClone(TILES);
const propIdx = (tiles) => tiles.findIndex((t) => t.type === 'property');

describe('真实配置', () => {
  it('规则与棋盘均通过校验', () => {
    expect(validateRules(RULES)).toEqual([]);
    expect(validateBoard(TILES, GROUPS, RULES)).toEqual([]);
  });

  it('40 格，四角位置正确，22 块地产', () => {
    expect(TILES).toHaveLength(40);
    expect([0, 10, 20, 30].map((i) => TILES[i].type)).toEqual(['start', 'jail', 'parking', 'goToJail']);
    expect(TILES.filter((t) => t.type === 'property')).toHaveLength(22);
  });
});

describe('validateBoard 反例', () => {
  const expectError = (tiles, fragment) =>
    expect(validateBoard(tiles, GROUPS, RULES).join('\n')).toContain(fragment);

  it('空棋盘', () => expectError([], '为空'));

  it('id 重复', () => {
    const t = clone();
    t[3].id = t[1].id;
    expectError(t, 'id 重复');
  });

  it('index 不连续', () => {
    const t = clone();
    t[5].index = 6;
    expectError(t, 'index 应为 5');
  });

  it('未知类型', () => {
    const t = clone();
    t[2].type = 'casino';
    expectError(t, '未知类型');
  });

  it('起点缺失 / 不在 0', () => {
    const t = clone();
    t[0].type = 'parking';
    expectError(t, 'start 必须恰好 1 个');
    expectError(t, '起点必须位于下标 0');
  });

  it('入狱格重复', () => {
    const t = clone();
    t[20].type = 'goToJail';
    expectError(t, 'goToJail 必须恰好 1 个');
  });

  it('颜色组少于 2 块', () => {
    const t = clone();
    const i = t.findIndex((x) => x.group === 'brown');
    t[i] = { index: i, type: 'parking', id: 'p2', name: '停车' };
    expectError(t, '颜色组 brown 至少需要 2 块');
  });

  it('未知颜色组', () => {
    const t = clone();
    t[propIdx(t)].group = 'purple';
    expectError(t, '未知颜色组');
  });

  it('价格非正整数', () => {
    const t = clone();
    t[propIdx(t)].price = -100;
    expectError(t, 'price 必须是正整数');
    t[propIdx(t)].price = 99.5;
    expectError(t, 'price 必须是正整数');
  });

  it('抵押价不低于购买价', () => {
    const t = clone();
    const p = t[propIdx(t)];
    p.mortgageValue = p.price;
    expectError(t, '抵押价必须低于购买价');
  });

  it('租金档数不对 / 不递增', () => {
    const t = clone();
    t[propIdx(t)].rent = [1, 2, 3];
    expectError(t, 'rent 必须有 5 档');
    t[propIdx(t)].rent = [10, 20, 20, 30, 40];
    expectError(t, 'rent 必须逐级递增');
  });

  it('税额非法', () => {
    const t = clone();
    t[4].amount = 0;
    expectError(t, '税额必须是正整数');
  });
});

describe('validateRules 反例', () => {
  it('人数与比例非法', () => {
    const errs = validateRules({ ...RULES, minPlayers: 1, maxPlayers: 0, mortgageInterestRate: 1 }).join('\n');
    expect(errs).toContain('minPlayers 至少为 2');
    expect(errs).toContain('maxPlayers');
    expect(errs).toContain('mortgageInterestRate');
  });
});

describe('createBoard', () => {
  const board = createBoard({ tiles: TILES, groups: GROUPS, rules: RULES });

  it('坏配置抛 BoardConfigError 并带错误列表', () => {
    const t = clone();
    t[1].id = t[3].id;
    try {
      createBoard({ tiles: t, groups: GROUPS, rules: RULES });
      expect.unreachable();
    } catch (e) {
      expect(e).toBeInstanceOf(BoardConfigError);
      expect(e.errors.length).toBeGreaterThan(0);
    }
  });

  it('坏规则先于棋盘报错', () => {
    expect(() => createBoard({ tiles: TILES, groups: GROUPS, rules: { ...RULES, maxLevel: 0 } })).toThrow(
      /maxLevel/,
    );
  });

  it('棋盘不可变，且与源配置隔离', () => {
    expect(() => {
      board.tiles[1].price = 1;
    }).toThrow(TypeError);
    expect(Object.isFrozen(board.getTile(1).rent)).toBe(true);
    expect(Object.isFrozen(TILES[1])).toBe(false);
  });

  it('getTile 越界与非整数', () => {
    expect(board.getTile(0).type).toBe('start');
    expect(board.getTile(39).id).toBe('beijing');
    for (const bad of [-1, 40, 1.5, NaN, '3', undefined]) {
      expect(() => board.getTile(bad)).toThrow(RangeError);
    }
  });

  it('advance 边界', () => {
    expect(board.advance(5, 0)).toEqual({ position: 5, laps: 0, passedStart: false });
    expect(board.advance(0, 12)).toEqual({ position: 12, laps: 0, passedStart: false });
    expect(board.advance(39, 2)).toEqual({ position: 1, laps: 1, passedStart: true });
    expect(board.advance(38, 2)).toEqual({ position: 0, laps: 1, passedStart: true }); // 正好停在起点
    expect(board.advance(10, 40)).toEqual({ position: 10, laps: 1, passedStart: true }); // 绕一整圈
    expect(board.advance(10, 80).laps).toBe(2);
    expect(board.advance(2, -3)).toEqual({ position: 39, laps: 0, passedStart: false }); // 后退跨过起点不奖励
    expect(board.advance(0, -41).position).toBe(39);
  });

  it('advance 非法输入', () => {
    expect(() => board.advance(0, 1.5)).toThrow(RangeError);
    expect(() => board.advance(0, NaN)).toThrow(RangeError);
    expect(() => board.advance(40, 1)).toThrow(RangeError);
  });

  it('getGroupTiles', () => {
    expect(board.getGroupTiles('darkBlue').map((t) => t.id)).toEqual(['shanghai', 'beijing']);
    expect(board.getGroupTiles('lightBlue')).toHaveLength(3);
    expect(() => board.getGroupTiles('purple')).toThrow(RangeError);
  });
});
