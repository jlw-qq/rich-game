/**
 * 表现层：开局页主视觉的演示脚本（heroScript）。
 */
import { describe, it, expect } from 'vitest';
import { TILES, GROUPS } from '../../src/data/config/board.js';
import { RULES } from '../../src/data/config/rules.js';
import { createBoard } from '../../src/logic/core/board.js';
import { validateState } from '../../src/logic/core/stateValidator.js';
import { calcRent } from '../../src/logic/systems/property.js';
import { heroScript } from '../../src/view/render/hero.js';

const board = createBoard({ tiles: TILES, groups: GROUPS, rules: RULES });

describe('开局页主视觉', () => {
  it('摆放前后都是合法状态；走路的终点、付的租金和状态一致', () => {
    const { state, events, after } = heroScript(board, RULES);
    expect(validateState(state, { board, rules: RULES, cards: [] })).toEqual([]);
    const move = events.find(([type]) => type === 'playerMoved')[1];
    expect(state.players[0].position).toBe(move.from);
    after();
    expect(validateState(state, { board, rules: RULES, cards: [] })).toEqual([]);
    expect(state.players[0].position).toBe(move.to);
    expect(board.getTile(move.to).id).toBe('beijing');
    const rent = events.find(([type]) => type === 'paymentMade')[1];
    expect(rent.amount).toBe(calcRent({ state, board, rules: RULES }, 'beijing'));
    expect(state.properties.xining.level).toBe(events[0][1].level);
  });

  it('每次都是一份新状态，播完不会影响下一轮', () => {
    const a = heroScript(board, RULES);
    a.after();
    expect(heroScript(board, RULES).state.players[0].position).toBe(36);
  });
});
