import { describe, it, expect } from 'vitest';
import { TILES, GROUPS } from '../../../src/data/config/board.js';
import { RULES } from '../../../src/data/config/rules.js';
import { CARDS } from '../../../src/data/config/cards.js';
import { checksum, createSaveStore, parseSave, serializeSave, SAVE_FORMAT } from '../../../src/data/save/saveFormat.js';
import { createBoard } from '../../../src/logic/core/board.js';
import { createEventBus } from '../../../src/logic/core/eventBus.js';
import { createInitialState } from '../../../src/logic/core/gameState.js';
import { createGame } from '../../../src/logic/core/game.js';
import { PHASES as P } from '../../../src/logic/core/turnMachine.js';
import { exportSave, importSave, checkLoadedState, SAVABLE_PHASES } from '../../../src/logic/core/saveGame.js';
import { validateState } from '../../../src/logic/core/stateValidator.js';
import { computeRanking } from '../../../src/logic/core/results.js';
import { createAiDriver } from '../../../src/logic/ai/driver.js';

const board = createBoard({ tiles: TILES, groups: GROUPS, rules: RULES });
const ctx = { board, rules: RULES, cards: CARDS };

function newGame({ n = 4, seed = 1, state } = {}) {
  const s =
    state ??
    createInitialState({
      board,
      rules: RULES,
      cards: CARDS,
      players: Array.from({ length: n }, (_, i) => ({ name: `AI${i + 1}`, isAI: true, aiLevel: i % 2 ? 'easy' : 'normal' })),
      seed,
    });
  const game = createGame({ board, rules: RULES, state: s, bus: createEventBus(), cards: CARDS });
  const driver = createAiDriver({ game, state: s, board, rules: RULES });
  return { state: s, game, driver };
}

/** 让 AI 走 steps 步，或走到终局 */
function advance({ driver }, steps) {
  for (let i = 0; i < steps && driver.isAiTurn(); i++) driver.step();
}

function fakeStorage() {
  const map = new Map();
  return {
    getItem: (k) => (map.has(k) ? map.get(k) : null),
    setItem: (k, v) => map.set(k, String(v)),
    removeItem: (k) => map.delete(k),
    map,
  };
}

describe('存档格式（数据层）', () => {
  it('序列化后能原样解析', () => {
    const { state } = newGame();
    const parsed = parseSave(serializeSave(state, { savedAt: 123 }));
    expect(parsed).toEqual({ ok: true, state, savedAt: 123 });
  });

  it.each([
    ['空字符串', ''],
    ['非字符串', 42],
    ['坏 JSON', '{"format":'],
    ['别的文件', JSON.stringify({ hello: 'world' })],
    ['数组', '[]'],
    ['超大文件', 'x'.repeat(1_000_001)],
  ])('拒绝：%s', (_, text) => {
    expect(parseSave(text).ok).toBe(false);
  });

  it('拒绝版本不符与校验和不符', () => {
    const { state } = newGame();
    const good = JSON.parse(serializeSave(state));
    expect(parseSave(JSON.stringify({ ...good, version: 99 })).error).toContain('版本');
    const tampered = structuredClone(good);
    tampered.state.players[0].cash = 99999999;
    expect(parseSave(JSON.stringify(tampered)).error).toContain('校验失败');
    // 截断
    expect(parseSave(serializeSave(state).slice(0, -10)).ok).toBe(false);
  });

  it('checksum 对内容敏感', () => {
    expect(checksum('abc')).not.toBe(checksum('abd'));
    expect(checksum('abc')).toMatch(/^[0-9a-f]{8}$/);
  });

  it('存储：保存、读取、清除；没有存档返回 null', () => {
    const storage = fakeStorage();
    const store = createSaveStore(storage, 'k');
    expect(store.load()).toBeNull();
    const { state } = newGame();
    expect(store.save(state).ok).toBe(true);
    expect(store.load()).toMatchObject({ ok: true, state });
    store.clear();
    expect(store.load()).toBeNull();
  });

  it('存储异常（容量满、被禁用）转成返回值，不抛错', () => {
    const broken = {
      getItem() {
        throw new Error('SecurityError');
      },
      setItem() {
        throw new Error('QuotaExceededError');
      },
      removeItem() {
        throw new Error('SecurityError');
      },
    };
    const store = createSaveStore(broken);
    const { state } = newGame();
    expect(store.save(state)).toMatchObject({ ok: false, error: expect.stringContaining('Quota') });
    expect(store.load()).toMatchObject({ ok: false });
    expect(() => store.clear()).not.toThrow();
    expect(createSaveStore(null).save(state).ok).toBe(false);
    expect(createSaveStore(null).load()).toBeNull();
  });
});

describe('读档：内容校验（逻辑层）', () => {
  it('AI 对战中每个可存档时刻的状态都能通过校验', () => {
    let checked = 0;
    for (let seed = 1; seed <= 12; seed++) {
      const g = newGame({ n: 2 + (seed % 4), seed });
      for (let i = 0; i < 20000 && g.driver.isAiTurn(); i++) {
        g.driver.step();
        if (!SAVABLE_PHASES.includes(g.state.phase)) throw new Error(`外部看到中间阶段: ${g.state.phase}`);
        if (i % 7 === 0 || g.state.phase === P.GAME_OVER) {
          const errors = validateState(g.state, ctx);
          if (errors.length > 0) throw new Error(`种子 ${seed} 第 ${i} 步: ${errors.join('; ')}`);
          checked++;
        }
      }
      expect(g.state.phase).toBe(P.GAME_OVER);
    }
    expect(checked).toBeGreaterThan(1000);
  });

  /** 修改存档里的 state 后重新计算校验和（模拟“格式正确但内容坏掉”的存档） */
  function corrupt(mutate) {
    const g = newGame();
    advance(g, 300);
    const state = structuredClone(g.state);
    mutate(state);
    return importSave(serializeSave(state), ctx);
  }

  it.each([
    ['现金为负', (s) => (s.players[0].cash = -1)],
    ['现金是小数', (s) => (s.players[0].cash = 10.5)],
    ['位置越界', (s) => (s.players[1].position = 40)],
    ['地主不存在', (s) => (s.properties.beijing = { ownerId: 'p9', level: 0, mortgaged: false })],
    ['等级越界', (s) => (s.properties.beijing = { ownerId: 'p1', level: 5, mortgaged: false })],
    ['抵押且有建筑', (s) => (s.properties.beijing = { ownerId: 'p1', level: 1, mortgaged: true })],
    ['少一块地产', (s) => delete s.properties.beijing],
    ['未知阶段', (s) => (s.phase = 'flying')],
    ['中间阶段', (s) => (s.phase = P.MOVING)],
    ['玩家太多', (s) => s.players.push(...structuredClone(s.players), ...structuredClone(s.players))],
    ['玩家列表不是数组', (s) => (s.players = {})],
    ['牌丢了一张', (s) => s.decks.chance.pop()],
    ['牌重复一张', (s) => s.decks.fate.push(s.decks.fate[0])],
    ['手里拿着普通卡', (s) => s.players[0].jailFreeCards.push(s.decks.chance.shift())],
    ['rngState 非法', (s) => (s.rngState = -5)],
    ['currentPlayerIndex 越界', (s) => (s.currentPlayerIndex = 9)],
    ['还款阶段缺欠款', (s) => ((s.phase = P.AWAIT_PAYMENT), (s.pendingDebt = null))],
    ['回合超过上限', (s) => (s.round = RULES.maxRounds + 1)],
    ['名字是 HTML 且超长', (s) => (s.players[0].name = '<img src=x onerror=alert(1)>')],
    ['state 是 null', (s) => Object.keys(s).forEach((k) => delete s[k])],
  ])('拒绝：%s', (_, mutate) => {
    const r = corrupt(mutate);
    expect(r.ok).toBe(false);
  });

  it('读档返回副本，修改它不影响原存档对象', () => {
    const g = newGame();
    advance(g, 50);
    const parsed = parseSave(serializeSave(g.state));
    const r = checkLoadedState(parsed, ctx);
    r.state.players[0].cash = 1;
    expect(parsed.state.players[0].cash).not.toBe(1);
  });

  it('中间阶段不能导出', () => {
    const g = newGame();
    g.state.phase = P.MOVING;
    expect(exportSave(g.state).ok).toBe(false);
  });
});

describe('读档后继续', () => {
  it.each([1, 2, 3, 4, 5])('种子 %i：中途存读档后继续，结果与不存档完全一致', (seed) => {
    const a = newGame({ seed, n: 4 });
    advance(a, 400);
    expect(a.state.phase).not.toBe(P.GAME_OVER);

    const loaded = importSave(exportSave(a.state).text, ctx);
    expect(loaded.ok).toBe(true);
    expect(loaded.state).toEqual(a.state);
    const b = newGame({ state: loaded.state });

    advance(a, 100000);
    advance(b, 100000);
    expect(b.state).toEqual(a.state);
    expect(b.state.phase).toBe(P.GAME_OVER);
  });

  it('在还款阶段存档，读档后可以继续还款或破产', () => {
    for (let seed = 1; seed <= 30; seed++) {
      const a = newGame({ seed, n: 3 });
      for (let i = 0; i < 20000 && a.driver.isAiTurn() && a.state.phase !== P.AWAIT_PAYMENT; i++) a.driver.step();
      if (a.state.phase !== P.AWAIT_PAYMENT) continue;
      const loaded = importSave(exportSave(a.state).text, ctx);
      expect(loaded.ok).toBe(true);
      const b = newGame({ state: loaded.state });
      advance(b, 100000);
      expect(b.state.phase).toBe(P.GAME_OVER);
      return;
    }
    throw new Error('30 局里都没有出现还款阶段，测试没有覆盖到');
  });
});

describe('排名', () => {
  function rankState(mutate) {
    const g = newGame({ n: 4 });
    mutate(g.state);
    return computeRanking({ state: g.state, board });
  }

  it('赢家第 1；存活按总资产；破产按先后（后破产名次高）', () => {
    const rows = rankState((s) => {
      s.players[0].cash = 100; // 存活，资产少
      s.players[1].cash = 20000; // 存活，资产多，赢家
      Object.assign(s.players[2], { bankrupt: true, bankruptOrder: 1, cash: 0 });
      Object.assign(s.players[3], { bankrupt: true, bankruptOrder: 2, cash: 0 });
      s.properties.beijing.ownerId = 'p1'; // p1 总资产 4100
      s.winnerId = 'p2';
    });
    expect(rows.map((r) => r.playerId)).toEqual(['p2', 'p1', 'p4', 'p3']);
    expect(rows.map((r) => r.rank)).toEqual([1, 2, 3, 4]);
    expect(rows[1]).toMatchObject({ netWorth: 4100, properties: 1, winner: false });
    expect(rows[0].winner).toBe(true);
  });

  it('资产并列按座位顺序', () => {
    const rows = rankState((s) => {
      s.winnerId = 'p1';
    });
    expect(rows.map((r) => r.playerId)).toEqual(['p1', 'p2', 'p3', 'p4']);
  });

  it('破产顺序在真实对局中记录正确', () => {
    for (let seed = 1; seed <= 40; seed++) {
      const g = newGame({ seed, n: 2 });
      advance(g, 100000);
      if (g.state.endReason !== 'bankruptcy') continue;
      const loser = g.state.players.find((p) => p.bankrupt);
      expect(loser.bankruptOrder).toBe(1);
      const rows = computeRanking({ state: g.state, board });
      expect(rows[0].playerId).toBe(g.state.winnerId);
      expect(rows[1].playerId).toBe(loser.id);
      return;
    }
    throw new Error('40 局里都没有破产终局');
  });
});

describe('存档格式标识', () => {
  it('存档文本带格式标识', () => {
    const { state } = newGame();
    expect(JSON.parse(serializeSave(state)).format).toBe(SAVE_FORMAT);
  });
});
