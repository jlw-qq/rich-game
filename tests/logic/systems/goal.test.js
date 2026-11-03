/**
 * 逻辑层：短局目标资产的进度（goalProgress）。
 */
import { describe, it, expect } from 'vitest';
import { TILES, GROUPS } from '../../../src/data/config/board.js';
import { RULES } from '../../../src/data/config/rules.js';
import { rulesFor } from '../../../src/data/config/modes.js';
import { createBoard } from '../../../src/logic/core/board.js';
import { createInitialState } from '../../../src/logic/core/gameState.js';
import { goalProgress } from '../../../src/logic/systems/goal.js';

const board = createBoard({ tiles: TILES, groups: GROUPS, rules: RULES });
const quick = rulesFor('quick', 3);

function setup(rules = quick) {
  const state = createInitialState({ board, rules, players: [{ name: '小红' }, { name: '小蓝' }, { name: '小绿' }], seed: 1 });
  for (const prop of Object.values(state.properties)) prop.ownerId = null;
  return state;
}

describe('目标进度', () => {
  it('经典模式没有目标资产，返回 null', () => {
    expect(goalProgress({ state: setup(RULES), board, rules: RULES })).toBeNull();
  });

  it('按座位顺序列出总资产、比例、差距和领先者', () => {
    const state = setup();
    state.players[0].cash = 6000;
    state.players[1].cash = 9000;
    state.players[2].cash = 3000;
    state.properties.xining.ownerId = 'p3'; // 地价 600 计入总资产
    const { goal, players } = goalProgress({ state, board, rules: quick });
    expect(goal).toBe(quick.goalNetWorth);
    expect(players).toEqual([
      { id: 'p1', worth: 6000, ratio: 6000 / goal, gap: goal - 6000, leader: false },
      { id: 'p2', worth: 9000, ratio: 9000 / goal, gap: goal - 9000, leader: true },
      { id: 'p3', worth: 3600, ratio: 3600 / goal, gap: goal - 3600, leader: false },
    ]);
  });

  it('超过目标时比例为 1、差距为 0；欠债为负时比例为 0', () => {
    const state = setup();
    state.players[0].cash = quick.goalNetWorth + 5000;
    state.players[1].cash = -200;
    const [a, b] = goalProgress({ state, board, rules: quick }).players;
    expect(a).toMatchObject({ ratio: 1, gap: 0, leader: true });
    expect(b).toMatchObject({ worth: -200, ratio: 0, gap: quick.goalNetWorth + 200 });
  });

  it('破产的人不列出；并列最高时都算领先', () => {
    const state = setup();
    state.players[0].cash = 5000;
    state.players[1].cash = 5000;
    state.players[2].bankrupt = true;
    state.players[2].cash = 99999;
    const { players } = goalProgress({ state, board, rules: quick });
    expect(players.map((e) => [e.id, e.leader])).toEqual([
      ['p1', true],
      ['p2', true],
    ]);
  });

  it('只剩一人时他就是领先者', () => {
    const state = setup();
    state.players[1].bankrupt = true;
    state.players[2].bankrupt = true;
    expect(goalProgress({ state, board, rules: quick }).players).toEqual([
      expect.objectContaining({ id: 'p1', leader: true }),
    ]);
  });
});
