/**
 * 逻辑层：操作记录（actionLog）和重放核实（replayChallenge）。
 * 「人类」玩家用 AI 策略代打（用另一个随机数，不碰 state 里的 AI 随机数），每一步像 main.js 一样经 performAction 执行并记录。
 */
import { describe, it, expect, vi } from 'vitest';
import { TILES, GROUPS } from '../../../src/data/config/board.js';
import { RULES } from '../../../src/data/config/rules.js';
import { CARDS } from '../../../src/data/config/cards.js';
import { rulesFor } from '../../../src/data/config/modes.js';
import { createBoard } from '../../../src/logic/core/board.js';
import { createGame } from '../../../src/logic/core/game.js';
import { createInitialState, migrateState, STATE_VERSION } from '../../../src/logic/core/gameState.js';
import { createEventBus } from '../../../src/logic/core/eventBus.js';
import { performAction } from '../../../src/logic/core/actions.js';
import { PHASES as P } from '../../../src/logic/core/turnMachine.js';
import { challengeScore } from '../../../src/logic/core/results.js';
import { validateState } from '../../../src/logic/core/stateValidator.js';
import { recordAction, cleanLoggedAction, actionLogErrors, MAX_LOGGED_ACTIONS } from '../../../src/logic/core/actionLog.js';
import { createAiDriver } from '../../../src/logic/ai/driver.js';
import { decideAction } from '../../../src/logic/ai/strategy.js';
import { createRng } from '../../../src/logic/utils/rng.js';
import { challengePlayers, dailyChallenge, decodeChallenge, encodeChallenge } from '../../../src/logic/systems/challenge.js';
import { replayChallenge, MAX_REPLAY_STEPS } from '../../../src/logic/systems/replay.js';

vi.setConfig({ testTimeout: 30_000 });
const board = createBoard({ tiles: TILES, groups: GROUPS, rules: RULES });
const ctx = { board, cards: CARDS };

/** 人类兜底：策略给的操作不合法时依次试这些，必有一个能推进 */
const FALLBACKS = [{ kind: 'endTurn' }, { kind: 'roll' }, { kind: 'decline' }, { kind: 'rejectTrade' }, { kind: 'choose', index: 0 }, { kind: 'pass' }, { kind: 'payDebt' }, { kind: 'bankrupt' }];

function newSession(state) {
  const rules = rulesFor(state.mode, state.players.length);
  const game = createGame({ board, rules, state, bus: createEventBus(), cards: CARDS });
  const driver = createAiDriver({ game, state, board, rules, cards: CARDS });
  return { state, rules, game, driver };
}

/**
 * 像网页一样打一局：AI 回合交给 AI 执行器，人类的每一步经 performAction 执行、成功才记录。
 * @param {{ code: string, humanSeed?: number, saveAt?: number }} o saveAt：打到第几步时「存档」——
 *   JSON 序列化再读回、换一个新的 game 和 AI 执行器接着打（模拟关掉页面后继续上一局）
 */
function playRecorded({ code, humanSeed = 1, saveAt = -1 }) {
  const config = replayConfig(code);
  const players = challengePlayers(config.kinds);
  const rules = rulesFor(config.mode, players.length);
  let s = newSession(createInitialState({ board, rules, cards: CARDS, players, seed: config.seed, mode: config.mode, challenge: { code, daily: null } }));
  const humanRng = createRng(humanSeed);
  for (let step = 0; s.state.phase !== P.GAME_OVER; step++) {
    if (step > MAX_REPLAY_STEPS) throw new Error('对局没有结束');
    if (step === saveAt) s = newSession(migrateState(JSON.parse(JSON.stringify(s.state))));
    if (s.driver.isAiTurn()) {
      s.driver.step();
      continue;
    }
    const me = s.game.actingPlayerId();
    const tried = [decideAction({ ...s, board, cards: CARDS }, me, { level: 'normal', rng: humanRng }), ...FALLBACKS];
    const done = tried.some((action) => {
      if (!action || !performAction(s.game, action).ok) return false;
      recordAction(s.state, action);
      return true;
    });
    if (!done) throw new Error(`人类玩家无路可走：${s.state.phase}`);
  }
  return s.state;
}

const replayConfig = (code) => decodeChallenge(code).config;

const daily = (date) => encodeChallenge(dailyChallenge(date));

describe('重放核实', () => {
  it.each([
    ['每日挑战', daily('2026-11-03')],
    ['另一天', daily('2026-12-25')],
    ['经典模式 2 人', encodeChallenge({ mode: 'classic', kinds: ['human', 'easy'], seed: 42 })],
  ])('%s：重放得到和本机完全一样的终局和成绩', (_, code) => {
    const played = playRecorded({ code });
    expect(played.actionLog.length).toBeGreaterThan(10);
    const r = replayChallenge(ctx, { code, actions: played.actionLog });
    expect(r.ok, r.error).toBe(true);
    expect(r.score).toEqual(challengeScore({ state: played, board }));
    expect(r.state.players).toEqual(played.players);
    expect(r.state.properties).toEqual(played.properties);
    expect(r.state.round).toBe(played.round);
  });

  it('中途存档、读档后接着打：记录能接上，重放结果一样', () => {
    const code = daily('2026-11-03');
    const straight = playRecorded({ code, humanSeed: 7 });
    const resumed = playRecorded({ code, humanSeed: 7, saveAt: 60 });
    expect(resumed.actionLog).toEqual(straight.actionLog);
    const r = replayChallenge(ctx, { code, actions: resumed.actionLog });
    expect(r.ok, r.error).toBe(true);
    expect(r.score).toEqual(challengeScore({ state: resumed, board }));
  });

  it('记录里有交易、升级、拍卖等各种操作（策略代打会用到）', () => {
    const kinds = new Set();
    for (const humanSeed of [1, 2, 3]) for (const a of playRecorded({ code: daily('2026-11-03'), humanSeed }).actionLog) kinds.add(a.kind);
    expect([...kinds]).toEqual(expect.arrayContaining(['roll', 'endTurn', 'buy']));
  });

  it('改动一步：要么当场不合法，要么对局走向不同，记录对不上', () => {
    const code = daily('2026-11-03');
    const { actionLog } = playRecorded({ code });
    // 把第一次买地改成不买
    const i = actionLog.findIndex((a) => a.kind === 'buy');
    const forged = actionLog.map((a, k) => (k === i ? { kind: 'decline' } : a));
    const r = replayChallenge(ctx, { code, actions: forged });
    if (r.ok) expect(r.score).not.toEqual(replayChallenge(ctx, { code, actions: actionLog }).score);
    else expect(r.error).toMatch(/不合法|用完|多出/);
  });

  it('少一步、多一步、空记录、对不上的挑战码都核实失败', () => {
    const code = daily('2026-11-03');
    const { actionLog } = playRecorded({ code });
    expect(replayChallenge(ctx, { code, actions: actionLog.slice(0, -1) })).toMatchObject({ ok: false, error: expect.stringMatching(/用完/) });
    expect(replayChallenge(ctx, { code, actions: [...actionLog, { kind: 'roll' }] })).toMatchObject({ ok: false, error: expect.stringMatching(/多出/) });
    expect(replayChallenge(ctx, { code, actions: [] })).toMatchObject({ ok: false });
    expect(replayChallenge(ctx, { code: daily('2026-11-04'), actions: actionLog }).ok).toBe(false);
  });

  it('输入不合法：坏挑战码、不是数组、格式不对、超长、全 AI 挑战', () => {
    const code = daily('2026-11-03');
    expect(replayChallenge(ctx, { code: 'CR-0000-0000-0000', actions: [] })).toMatchObject({ ok: false });
    expect(replayChallenge(ctx, { code, actions: 'roll' })).toMatchObject({ ok: false, error: '操作记录必须是数组' });
    expect(replayChallenge(ctx, { code, actions: [{ kind: 'hack' }] })).toMatchObject({ ok: false, error: '第 1 步格式无效' });
    expect(replayChallenge(ctx, { code, actions: [{ kind: 'roll', tileId: { $gt: 1 } }] })).toMatchObject({ ok: false });
    const long = Array.from({ length: MAX_LOGGED_ACTIONS + 1 }, () => ({ kind: 'roll' }));
    expect(replayChallenge(ctx, { code, actions: long })).toMatchObject({ ok: false, error: expect.stringMatching(/超过/) });
    const allAi = encodeChallenge({ mode: 'quick', kinds: ['normal', 'easy'], seed: 1 });
    expect(replayChallenge(ctx, { code: allAi, actions: [] })).toMatchObject({ ok: false, error: '这个挑战没有人类玩家' });
  });

  it('重放一局很快（几十毫秒以内）', () => {
    const code = daily('2026-11-03');
    const { actionLog } = playRecorded({ code });
    const t = performance.now();
    replayChallenge(ctx, { code, actions: actionLog });
    expect(performance.now() - t).toBeLessThan(500);
  });
});

describe('操作记录', () => {
  it('新开局是空数组，旧存档迁移后为 null（不能上榜）；格式通过存档校验', () => {
    const players = challengePlayers(['human', 'normal']);
    const state = createInitialState({ board, rules: RULES, cards: CARDS, players, seed: 1 });
    expect(state.actionLog).toEqual([]);
    expect(STATE_VERSION).toBe(7);
    expect(migrateState({ version: 6, players: [] })).toMatchObject({ version: 7, actionLog: null });
    expect(validateState(state, { board, rules: RULES, cards: CARDS })).toEqual([]);
    expect(validateState({ ...state, actionLog: 'x' }, { board, rules: RULES, cards: CARDS })).toContain('actionLog 必须是数组或 null');
    expect(validateState({ ...state, actionLog: [{ kind: 'nope' }] }, { board, rules: RULES, cards: CARDS })).toContain('actionLog[0] 格式无效');
  });

  it('只留认识的字段；交易两边整理成纯数据', () => {
    expect(cleanLoggedAction({ kind: 'upgrade', tileId: 'xining', label: '升级 西宁', primary: true })).toEqual({ kind: 'upgrade', tileId: 'xining' });
    expect(cleanLoggedAction({ kind: 'proposeTrade', trade: { toId: 'p2', give: { cash: 100 }, take: { properties: ['beijing'] }, x: 1 } })).toEqual({
      kind: 'proposeTrade',
      trade: { toId: 'p2', give: { properties: [], cash: 100, jailCards: 0 }, take: { properties: ['beijing'], cash: 0, jailCards: 0 } },
    });
    expect(cleanLoggedAction({ kind: 'bid', amount: -1 })).toBeNull();
    expect(cleanLoggedAction({ kind: 'choose', index: 99 })).toBeNull();
    expect(actionLogErrors(null)).toEqual([]);
  });

  it('超出上限或遇到认不出的操作：记录作废为 null，之后不再记', () => {
    const state = { actionLog: Array.from({ length: MAX_LOGGED_ACTIONS }, () => ({ kind: 'roll' })) };
    recordAction(state, { kind: 'roll' });
    expect(state.actionLog).toBeNull();
    recordAction(state, { kind: 'roll' });
    expect(state.actionLog).toBeNull();
    const s2 = { actionLog: [] };
    recordAction(s2, { kind: 'weird' });
    expect(s2.actionLog).toBeNull();
  });
});
