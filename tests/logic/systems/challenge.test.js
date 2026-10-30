/**
 * 逻辑层：挑战码编解码、每日挑战、同码复现同一局、挑战成绩、存档迁移到版本 5。
 */
import { describe, it, expect } from 'vitest';
import { TILES, GROUPS } from '../../../src/data/config/board.js';
import { RULES } from '../../../src/data/config/rules.js';
import { CARDS } from '../../../src/data/config/cards.js';
import { MODES, rulesFor } from '../../../src/data/config/modes.js';
import { DAILY_CHALLENGE } from '../../../src/data/config/challenge.js';
import { createRecordStore, MAX_RECORDS } from '../../../src/data/save/challengeRecords.js';
import { serializeSave } from '../../../src/data/save/saveFormat.js';
import { createBoard } from '../../../src/logic/core/board.js';
import { createEventBus } from '../../../src/logic/core/eventBus.js';
import { createInitialState, migrateState, STATE_VERSION } from '../../../src/logic/core/gameState.js';
import { createGame } from '../../../src/logic/core/game.js';
import { createAiDriver } from '../../../src/logic/ai/driver.js';
import { PHASES as P } from '../../../src/logic/core/turnMachine.js';
import { validateState } from '../../../src/logic/core/stateValidator.js';
import { importSave } from '../../../src/logic/core/saveGame.js';
import { challengeScore, isBetterScore, isChallengeScore } from '../../../src/logic/core/results.js';
import {
  CHALLENGE_MODES,
  challengePlayers,
  dailyChallenge,
  decodeChallenge,
  encodeChallenge,
  isDateKey,
  localDateKey,
  seatKinds,
} from '../../../src/logic/systems/challenge.js';

const board = createBoard({ tiles: TILES, groups: GROUPS, rules: RULES });
const ctx = { board, rules: RULES, cards: CARDS };

/** 按挑战配置开局，和 main.js 的做法一致 */
function startFrom(config, daily = null) {
  const players = challengePlayers(config.kinds);
  const rules = rulesFor(config.mode, players.length);
  const challenge = { code: encodeChallenge(config), daily };
  const state = createInitialState({ board, rules, cards: CARDS, players, seed: config.seed, mode: config.mode, challenge });
  return { rules, state };
}

/** 全 AI 对局打到结束 */
function playOut({ rules, state }) {
  const game = createGame({ board, rules, state, bus: createEventBus(), cards: CARDS });
  const driver = createAiDriver({ game, state, board, rules, cards: CARDS });
  let steps = 0;
  while (driver.isAiTurn() && steps++ < 100000) driver.step();
  return driver;
}

describe('挑战码编解码', () => {
  it('编码后能解回原配置，格式为 CR-XXXX-XXXX-XXXX', () => {
    const configs = [
      { mode: 'quick', kinds: ['human', 'normal'], seed: 0 },
      { mode: 'classic', kinds: ['easy', 'normal', 'human', 'human', 'easy'], seed: 0xffffffff },
      { mode: 'quick', kinds: ['human', 'normal', 'normal', 'normal'], seed: 123456789 },
    ];
    for (const config of configs) {
      const code = encodeChallenge(config);
      expect(code).toMatch(/^CR-[0-9A-HJKMNP-TV-Z]{4}-[0-9A-HJKMNP-TV-Z]{4}-[0-9A-HJKMNP-TV-Z]{4}$/);
      expect(decodeChallenge(code)).toEqual({ ok: true, code, config });
    }
  });

  it('不区分大小写，可省略 CR 和横线，O/I/L 按 0/1 读', () => {
    const code = encodeChallenge({ mode: 'quick', kinds: ['human', 'easy', 'normal'], seed: 42 });
    const body = code.slice(3).replace(/-/g, '');
    expect(decodeChallenge(body.toLowerCase()).code).toBe(code);
    expect(decodeChallenge(` ${code.toLowerCase()} `).code).toBe(code);
    expect(decodeChallenge(`cr ${body}`).code).toBe(code);
    if (body.includes('0')) expect(decodeChallenge(body.replace(/0/g, 'O')).code).toBe(code);
    if (body.includes('1')) expect(decodeChallenge(body.replace(/1/g, 'l')).code).toBe(code);
  });

  it('错误的码给出明确原因，不抛异常', () => {
    const code = encodeChallenge({ mode: 'quick', kinds: ['human', 'normal'], seed: 7 });
    expect(decodeChallenge('').error).toContain('请输入');
    expect(decodeChallenge('   ').error).toContain('请输入');
    expect(decodeChallenge(null).error).toContain('请输入');
    expect(decodeChallenge('CR-1234').error).toContain('12 位');
    expect(decodeChallenge('x'.repeat(41)).error).toContain('太长');
    expect(decodeChallenge('CR-UUUU-0000-0000').error).toContain('无效字符：U');
    expect(decodeChallenge('CR-0000-0000-00*0').error).toContain('无效字符');
    // 改动任意一位都应被校验发现
    const body = code.replace(/^CR-|-/g, '');
    for (let i = 0; i < body.length; i++) {
      const c = body[i] === '2' ? '3' : '2';
      expect(decodeChallenge(body.slice(0, i) + c + body.slice(i + 1)).error, `第 ${i} 位`).toContain('校验');
    }
  });

  it('版本号太新时提示刷新；多余座位不为 0 时拒绝', () => {
    // 绕过 encodeChallenge 构造特殊位：复制编码算法里的打包与校验
    const ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
    const fnvCheck = (data) => {
      let h = 0x811c9dc5;
      for (let i = 0; i < 6; i++) {
        h ^= Number((data >> BigInt(8 * (5 - i))) & 0xffn);
        h = Math.imul(h, 0x01000193);
      }
      h >>>= 0;
      return (h ^ (h >>> 12) ^ (h >>> 24)) & 0xfff;
    };
    const make = (version, slots) => {
      let data = BigInt(version);
      data = (data << 1n) | 0n;
      data = (data << 2n) | 0n; // 2 人
      for (const v of slots) data = (data << 2n) | BigInt(v);
      data = (data << 32n) | 99n;
      const value = (data << 12n) | BigInt(fnvCheck(data));
      let s = '';
      for (let i = 11; i >= 0; i--) s += ALPHABET[Number((value >> BigInt(5 * i)) & 31n)];
      return s;
    };
    expect(decodeChallenge(make(1, [0, 1, 0, 0, 0])).ok).toBe(true);
    expect(decodeChallenge(make(2, [0, 1, 0, 0, 0])).error).toContain('更新版本');
    expect(decodeChallenge(make(0, [0, 1, 0, 0, 0])).error).toBe('挑战码无效');
    expect(decodeChallenge(make(1, [0, 1, 1, 0, 0])).error).toBe('挑战码无效');
    expect(decodeChallenge(make(1, [0, 3, 0, 0, 0])).error).toContain('玩家类型');
  });

  it('非法配置编码时报错', () => {
    expect(() => encodeChallenge({ mode: 'blitz', kinds: ['human', 'normal'], seed: 1 })).toThrow('模式');
    expect(() => encodeChallenge({ mode: 'quick', kinds: ['human'], seed: 1 })).toThrow('人数');
    expect(() => encodeChallenge({ mode: 'quick', kinds: Array(6).fill('human'), seed: 1 })).toThrow('人数');
    expect(() => encodeChallenge({ mode: 'quick', kinds: ['human', 'hard'], seed: 1 })).toThrow('类型');
    expect(() => encodeChallenge({ mode: 'quick', kinds: ['human', 'normal'], seed: -1 })).toThrow('种子');
    expect(() => encodeChallenge({ mode: 'quick', kinds: ['human', 'normal'], seed: 1.5 })).toThrow('种子');
  });

  it('挑战码覆盖所有模式和人数上下限', () => {
    expect([...CHALLENGE_MODES].sort()).toEqual(Object.keys(MODES).sort());
    expect(RULES.minPlayers).toBe(2);
    expect(RULES.maxPlayers).toBe(5);
  });
});

describe('同一个挑战码复现同一局', () => {
  it('开局状态完全一样（分地、牌堆、随机数状态）', () => {
    const config = decodeChallenge(encodeChallenge({ mode: 'quick', kinds: ['human', 'normal', 'easy'], seed: 2026 })).config;
    expect(startFrom(config).state).toEqual(startFrom(config).state);
    expect(startFrom({ ...config, seed: 2027 }).state.properties).not.toEqual(startFrom(config).state.properties);
  });

  it('全 AI 对局从同一个码打到结束，每一步都一样，且不会卡死', () => {
    for (const mode of ['quick', 'classic']) {
      const config = { mode, kinds: ['normal', 'easy', 'normal', 'normal'], seed: 31337 };
      const a = startFrom(config);
      const b = startFrom(config);
      const driverA = playOut(a);
      playOut(b);
      expect(a.state.phase).toBe(P.GAME_OVER);
      expect(driverA.stats.fallbacks).toBe(0);
      expect(a.state).toEqual(b.state);
      expect(validateState(a.state, ctx)).toEqual([]);
    }
  });

  it('人类玩家名字按座位取，只有一位人类时叫“你”', () => {
    expect(challengePlayers(['human', 'normal', 'easy']).map((p) => p.name)).toEqual(['你', '小蓝', '小黄']);
    expect(challengePlayers(['normal', 'human', 'human']).map((p) => p.name)).toEqual(['小红', '小蓝', '小黄']);
    expect(seatKinds(challengePlayers(['easy', 'human', 'normal']))).toEqual(['easy', 'human', 'normal']);
  });

  it('挑战码与对局设置或种子不符时拒绝开局', () => {
    const config = { mode: 'quick', kinds: ['human', 'normal'], seed: 5 };
    const players = challengePlayers(config.kinds);
    const make = (over) =>
      createInitialState({
        board,
        rules: rulesFor('quick', 2),
        cards: CARDS,
        players,
        seed: 5,
        mode: 'quick',
        challenge: { code: encodeChallenge(config), daily: null },
        ...over,
      });
    expect(make({}).challenge).toEqual({ code: encodeChallenge(config), daily: null });
    expect(() => make({ seed: 6 })).toThrow('种子');
    expect(() => make({ mode: 'classic', rules: RULES })).toThrow('不一致');
    expect(() => make({ players: challengePlayers(['normal', 'normal']) })).toThrow('不一致');
    expect(() => make({ challenge: { code: 'CR-0000', daily: null } })).toThrow('挑战码无效');
    expect(() => make({ challenge: { code: encodeChallenge(config), daily: '2026-13-01' } })).toThrow('日期');
  });
});

describe('每日挑战', () => {
  it('同一天种子相同，不同天不同', () => {
    expect(dailyChallenge('2026-10-30')).toEqual(dailyChallenge('2026-10-30'));
    const seeds = new Set(Array.from({ length: 60 }, (_, i) => dailyChallenge(localDateKey(new Date(2026, 0, 1 + i))).seed));
    expect(seeds.size).toBe(60);
    expect(dailyChallenge('2026-10-30')).toMatchObject({ mode: DAILY_CHALLENGE.mode, kinds: DAILY_CHALLENGE.kinds });
  });

  it('按本地日历日换题：23:59 和次日 00:00 是两天，跨年、闰日正确', () => {
    expect(localDateKey(new Date(2026, 9, 30, 23, 59, 59))).toBe('2026-10-30');
    expect(localDateKey(new Date(2026, 9, 31, 0, 0, 0))).toBe('2026-10-31');
    expect(localDateKey(new Date(2026, 11, 31, 23, 59))).toBe('2026-12-31');
    expect(localDateKey(new Date(2027, 0, 1, 0, 0))).toBe('2027-01-01');
    expect(localDateKey(new Date(2028, 1, 29, 12))).toBe('2028-02-29');
  });

  it('日期格式校验', () => {
    expect(isDateKey('2028-02-29')).toBe(true);
    for (const bad of ['2026-02-29', '2026-13-01', '2026-00-10', '2026-1-1', '20261030', '', null, 20261030]) {
      expect(isDateKey(bad), String(bad)).toBe(false);
    }
    expect(() => dailyChallenge('2026-02-30')).toThrow('日期');
  });

  it('每日挑战标记必须与日期对应', () => {
    const { state } = startFrom(dailyChallenge('2026-10-30'), '2026-10-30');
    expect(validateState(state, ctx)).toEqual([]);
    state.challenge.daily = '2026-10-31';
    expect(validateState(state, ctx).join()).toContain('不是这一天');
  });
});

describe('挑战成绩', () => {
  const score = (rank, netWorth, round, bankrupt = false) => ({ rank, players: 4, bankrupt, netWorth, round });

  it('比较顺序：名次 > 总资产 > 轮数', () => {
    expect(isBetterScore(score(1, 100, 20), null)).toBe(true);
    expect(isBetterScore(score(1, 100, 20), score(2, 9000, 5))).toBe(true);
    expect(isBetterScore(score(2, 9000, 20), score(2, 8000, 5))).toBe(true);
    expect(isBetterScore(score(2, 9000, 10), score(2, 9000, 12))).toBe(true);
    expect(isBetterScore(score(2, 9000, 12), score(2, 9000, 12))).toBe(false);
  });

  it('取第一位人类的名次；全 AI 对局没有成绩', () => {
    const daily = startFrom(dailyChallenge('2026-10-30'), '2026-10-30');
    const s = challengeScore({ state: daily.state, board });
    expect(isChallengeScore(s)).toBe(true);
    expect(s).toMatchObject({ players: 4, round: 1, bankrupt: false });
    const ai = startFrom({ mode: 'quick', kinds: ['normal', 'normal'], seed: 1 });
    expect(challengeScore({ state: ai.state, board })).toBeNull();
  });

  it('本地记录形状检查', () => {
    expect(isChallengeScore(score(1, 0, 1))).toBe(true);
    for (const bad of [null, {}, score(5, 0, 1), score(0, 0, 1), score(1, -1, 1), score(1, 0, 0), { ...score(1, 0, 1), bankrupt: 'no' }]) {
      expect(isChallengeScore(bad)).toBe(false);
    }
  });
});

describe('挑战记录存储', () => {
  const memoryStorage = () => {
    const m = new Map();
    return { getItem: (k) => (m.has(k) ? m.get(k) : null), setItem: (k, v) => m.set(k, String(v)), map: m };
  };

  it('按挑战码读写，超出上限时丢掉最早的', () => {
    const storage = memoryStorage();
    const store = createRecordStore(storage);
    for (let i = 0; i < MAX_RECORDS + 3; i++) expect(store.set(`code${i}`, { i })).toBe(true);
    expect(store.get('code0')).toBeUndefined();
    expect(store.get('code3')).toEqual({ i: 3 });
    // 重写已有记录会把它挪到最新
    store.set('code3', { i: 'again' });
    store.set('extra', {});
    expect(store.get('code3')).toEqual({ i: 'again' });
    expect(store.get('code4')).toBeUndefined();
  });

  it('存储不可用、抛错或数据损坏时当作没有记录', () => {
    expect(createRecordStore(null).get('x')).toBeUndefined();
    expect(createRecordStore(null).set('x', {})).toBe(false);
    const throwing = { getItem: () => { throw new Error('denied'); }, setItem: () => { throw new Error('full'); } };
    expect(createRecordStore(throwing).get('x')).toBeUndefined();
    expect(createRecordStore(throwing).set('x', {})).toBe(false);
    const broken = memoryStorage();
    broken.setItem('rich-game:challenge-best', '{not json');
    expect(createRecordStore(broken).get('x')).toBeUndefined();
    broken.setItem('rich-game:challenge-best', '[1,2]');
    expect(createRecordStore(broken).get('0')).toBeUndefined();
  });
});

describe('存档迁移到版本 5', () => {
  it('版本 4 存档补上 challenge: null 后能读取', () => {
    const { state } = startFrom({ mode: 'quick', kinds: ['human', 'normal'], seed: 9 });
    const v4 = structuredClone(state);
    v4.version = 4;
    delete v4.challenge;
    const loaded = importSave(serializeSave(v4), ctx);
    expect(loaded.ok).toBe(true);
    expect(loaded.state).toMatchObject({ version: STATE_VERSION, challenge: null });
    expect(migrateState({ version: 1, players: [] })).toMatchObject({ version: 5, challenge: null });
  });

  it('当前版本缺少或改坏挑战码时拒绝读档', () => {
    const { state } = startFrom({ mode: 'quick', kinds: ['human', 'normal'], seed: 9 });
    expect(validateState(state, ctx)).toEqual([]);
    expect(validateState({ ...state, challenge: undefined }, ctx).join()).toContain('challenge');
    expect(validateState({ ...state, challenge: { code: 'CR-0000-0000-0000', daily: null } }, ctx).join()).toContain('挑战码');
    const other = encodeChallenge({ mode: 'quick', kinds: ['normal', 'normal'], seed: 9 });
    expect(validateState({ ...state, challenge: { code: other, daily: null } }, ctx).join()).toContain('不一致');
  });
});
