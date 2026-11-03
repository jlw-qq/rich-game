/**
 * 逻辑层：本回合的经营机会（turnHints），以及操作区里的提示文字（hintLines）。
 */
import { describe, it, expect } from 'vitest';
import { TILES, GROUPS } from '../../../src/data/config/board.js';
import { RULES } from '../../../src/data/config/rules.js';
import { rulesFor } from '../../../src/data/config/modes.js';
import { createBoard } from '../../../src/logic/core/board.js';
import { createInitialState } from '../../../src/logic/core/gameState.js';
import { turnHints } from '../../../src/logic/systems/hints.js';
import { hintLines } from '../../../src/view/ui/panel.js';
import { money } from '../../../src/view/ui/format.js';

const board = createBoard({ tiles: TILES, groups: GROUPS, rules: RULES });

/** 默认经典规则（没有目标资产），3 名玩家 */
function setup(rules = RULES) {
  const state = createInitialState({ board, rules, players: [{ name: '小红' }, { name: '小蓝' }, { name: '小绿' }], seed: 1 });
  // 短局开局随机送地，这里清空，每个用例自己摆
  for (const prop of Object.values(state.properties)) prop.ownerId = null;
  return { state, ctx: { state, board, rules } };
}
const own = (state, playerId, ...ids) => ids.forEach((id) => (state.properties[id].ownerId = playerId));

describe('可升级的地产', () => {
  it('没凑齐整组时不能升级', () => {
    const { state, ctx } = setup();
    own(state, 'p1', 'xining');
    expect(turnHints(ctx, 'p1').upgrades).toBeNull();
  });

  it('凑齐整组：列出数量，以及租金涨得最多的一块（from 含整组翻倍）', () => {
    const { state, ctx } = setup();
    own(state, 'p1', 'xining', 'yinchuan');
    const h = turnHints(ctx, 'p1');
    // 银川空地 40×2=80 → 1 级 200；西宁 20×2=40 → 100
    expect(h.upgrades).toEqual({ count: 2, best: { tileId: 'yinchuan', cost: 500, from: 80, to: 200 } });
  });

  it('现金不够、组里有抵押、已满级的地不算', () => {
    const { state, ctx } = setup();
    own(state, 'p1', 'xining', 'yinchuan');
    state.players[0].cash = 499;
    expect(turnHints(ctx, 'p1').upgrades).toBeNull();

    state.players[0].cash = 5000;
    state.properties.xining.mortgaged = true;
    expect(turnHints(ctx, 'p1').upgrades).toBeNull();

    state.properties.xining.mortgaged = false;
    state.properties.yinchuan.level = RULES.maxLevel;
    expect(turnHints(ctx, 'p1').upgrades).toMatchObject({ count: 1, best: { tileId: 'xining' } });
  });

  it('租金按这一局的倍数算（短局租金 ×2）', () => {
    const rules = rulesFor('quick', 3);
    const { state, ctx } = setup(rules);
    own(state, 'p1', 'xining', 'yinchuan');
    expect(turnHints(ctx, 'p1').upgrades.best).toMatchObject({ tileId: 'yinchuan', from: 160, to: 400 });
  });
});

describe('差一块凑齐的颜色组', () => {
  it('列出差的那一块和它的主人；差两块或已凑齐的组不列', () => {
    const { state, ctx } = setup();
    own(state, 'p1', 'lanzhou', 'huhehaote', 'nanning', 'xining', 'yinchuan');
    own(state, 'p2', 'taiyuan');
    const h = turnHints(ctx, 'p1');
    // 浅蓝差太原（在小蓝手里）；粉色差两块；棕色已凑齐
    expect(h.groups).toEqual([{ group: 'lightBlue', tileId: 'taiyuan', ownerId: 'p2', here: false }]);
  });

  it('停在差的那块上、正要决定买不买时排在最前，并标出 here', () => {
    const { state, ctx } = setup();
    own(state, 'p1', 'lanzhou', 'huhehaote', 'shanghai');
    state.players[0].position = 39; // 北京
    state.phase = 'awaitDecision';
    const h = turnHints(ctx, 'p1');
    expect(h.groups[0]).toEqual({ group: 'darkBlue', tileId: 'beijing', ownerId: null, here: true });
    expect(h.groups[1]).toMatchObject({ group: 'lightBlue', tileId: 'taiyuan', here: false });
  });

  it('最多列两组', () => {
    const { state, ctx } = setup();
    own(state, 'p1', 'xining', 'lanzhou', 'huhehaote', 'nanning', 'kunming', 'shanghai');
    expect(turnHints(ctx, 'p1').groups).toHaveLength(2);
  });
});

describe('离目标还差多少', () => {
  it('经典模式没有目标资产', () => {
    const { ctx } = setup();
    expect(turnHints(ctx, 'p1').goal).toBeNull();
  });

  it('短局：领先者和自己各差多少；破产的人不算领先，已达到时差 0', () => {
    const rules = rulesFor('quick', 3);
    const { state, ctx } = setup(rules);
    state.players[0].cash = 10000;
    state.players[1].cash = 26000;
    state.players[2].cash = 99999;
    state.players[2].bankrupt = true;
    expect(turnHints(ctx, 'p1').goal).toEqual({ leaderId: 'p2', leaderGap: rules.goalNetWorth - 26000, myGap: rules.goalNetWorth - 10000 });
    state.players[1].cash = rules.goalNetWorth + 5;
    expect(turnHints(ctx, 'p1').goal.leaderGap).toBe(0);
  });

  it('破产的玩家没有提示', () => {
    const { state, ctx } = setup();
    state.players[0].bankrupt = true;
    expect(turnHints(ctx, 'p1')).toEqual({ upgrades: null, groups: [], goal: null });
  });
});

describe('提示文字', () => {
  const quick = rulesFor('quick', 3);
  const texts = (state, rules) => hintLines(state, board, rules, state.players[0]).map((l) => l.text);

  it('掷骰前：升级、凑组、目标各一行', () => {
    const { state } = setup(quick);
    own(state, 'p1', 'xining', 'yinchuan', 'lanzhou', 'huhehaote');
    own(state, 'p2', 'taiyuan');
    state.players[0].cash = 9000;
    state.players[1].cash = 10000; // 加上太原 1,200 仍低于小红
    state.phase = 'awaitRoll';
    expect(texts(state, quick)).toEqual([
      `可升级 2 块地，最划算：银川 花 ${money(500)}，租金 ${money(160)} → ${money(400)}`,
      '还差 太原 就凑齐整组，它在 小蓝 手里，可以试试交易',
      `你领先，离目标还差 ${money(quick.goalNetWorth - 9000 - 1200 - 2000)}`,
    ]);
  });

  it('决定买地时不提升级（这时不能升级），停着的那块凑组时直接说“买下就凑齐”', () => {
    const { state } = setup(RULES);
    own(state, 'p1', 'xining', 'yinchuan', 'shanghai');
    state.players[0].position = 39;
    state.phase = 'awaitDecision';
    expect(texts(state, RULES)).toEqual(['买下 北京 就凑齐整组，空地租金 ×2，还能盖楼']);
  });

  it('差的那块无主时写明无主', () => {
    const { state } = setup(RULES);
    own(state, 'p1', 'shanghai');
    state.phase = 'awaitRoll';
    expect(texts(state, RULES)).toEqual(['还差 北京（无主）就凑齐整组，空地租金 ×2，还能盖楼']);
  });

  it('别人领先时写出双方差距；什么机会都没有时为空', () => {
    const { state } = setup(quick);
    state.players[0].cash = 1000;
    state.players[1].cash = 2000;
    state.players[2].cash = 500;
    state.phase = 'awaitRoll';
    expect(texts(state, quick)).toEqual([
      `小蓝 领先，离目标还差 ${money(quick.goalNetWorth - 2000)}；你还差 ${money(quick.goalNetWorth - 1000)}`,
    ]);
    const { state: classic } = setup(RULES);
    classic.phase = 'awaitRoll';
    expect(texts(classic, RULES)).toEqual([]);
  });
});

describe('提示里能直接执行的操作', () => {
  const quick = rulesFor('quick', 3);
  const actions = (state, rules, options) => hintLines(state, board, rules, state.players[0], options).map((l) => l.action ?? null);

  it('掷骰前：升级最划算的一块、找地主交易；目标差距不带按钮', () => {
    const { state } = setup(quick);
    own(state, 'p1', 'xining', 'yinchuan', 'lanzhou', 'huhehaote');
    own(state, 'p2', 'taiyuan');
    state.players[0].cash = 9000;
    state.phase = 'awaitRoll';
    expect(actions(state, quick, { maxTradesPerTurn: 2 })).toEqual([
      { kind: 'upgrade', tileId: 'yinchuan', label: '升级 银川' },
      { kind: 'openTrade', partnerId: 'p2', takeTileIds: ['taiyuan'], label: '找 小蓝 交易' },
      null,
    ]);
  });

  it('本回合交易次数用完时不出交易按钮，文字照常', () => {
    const { state } = setup(RULES);
    own(state, 'p1', 'xining');
    own(state, 'p2', 'yinchuan');
    state.phase = 'awaitRoll';
    state.tradesThisTurn = 2;
    const lines = hintLines(state, board, RULES, state.players[0], { maxTradesPerTurn: 2 });
    expect(lines).toEqual([{ text: '还差 银川 就凑齐整组，它在 小蓝 手里，可以试试交易' }]);
  });

  it('决定买地时：不能升级也不能交易，停着的那块凑组时不重复放「买下」', () => {
    const { state } = setup(RULES);
    own(state, 'p1', 'xining');
    own(state, 'p2', 'yinchuan');
    state.phase = 'awaitDecision';
    expect(actions(state, RULES)).toEqual([null]);
    const { state: here } = setup(RULES);
    own(here, 'p1', 'xining', 'yinchuan', 'shanghai');
    here.players[0].position = 39;
    here.phase = 'awaitDecision';
    expect(actions(here, RULES)).toEqual([null]);
  });

  it('差的那块无主：在棋盘上查看它', () => {
    const { state } = setup(RULES);
    own(state, 'p1', 'shanghai');
    state.phase = 'awaitRoll';
    expect(actions(state, RULES)).toEqual([{ kind: 'viewTile', tileId: 'beijing', label: '在棋盘上看 北京' }]);
  });

  it('现金刚好等于升级费也能升级；差 1 元就没有升级按钮', () => {
    const { state } = setup(RULES);
    own(state, 'p1', 'xining', 'yinchuan');
    state.phase = 'awaitRoll';
    state.players[0].cash = 500;
    expect(actions(state, RULES)[0]).toMatchObject({ kind: 'upgrade' });
    state.players[0].cash = 499;
    expect(actions(state, RULES)).toEqual([]);
  });
});
