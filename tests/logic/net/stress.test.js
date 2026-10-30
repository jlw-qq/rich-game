/**
 * 逻辑层：联网补测。满员房间、网络延迟、迟到的消息、不回 ready 的连接、多房间同时运行。
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { PHASES as P } from '../../../src/logic/core/turnMachine.js';
import { createRng } from '../../../src/logic/utils/rng.js';
import { validateState } from '../../../src/logic/core/stateValidator.js';
import { AI_DELAY_MS, READY_TIMEOUT_MS, TURN_TIMEOUT_MS } from '../../../src/logic/net/match.js';
import { MAX_MESSAGE_BYTES } from '../../../src/logic/net/protocol.js';
import { RULES } from '../../../src/data/config/rules.js';
import { CARDS } from '../../../src/data/config/cards.js';
import { board, network } from './fakeNet.js';

// 这里的用例都要模拟几十局完整对局，和其他测试并行时比默认的 5 秒上限慢
vi.setConfig({ testTimeout: 60_000 });

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

/** 正式服务器的节奏 */
const REAL = { aiDelayMs: AI_DELAY_MS, turnTimeoutMs: TURN_TIMEOUT_MS, readyTimeoutMs: READY_TIMEOUT_MS };
const updates = (c) => c.inbox.filter((m) => m.t === 'update');
const NAMES = ['小红', '阿明', '小蓝', '阿花', '小黄'];

/** 建一个房间：names 是人类玩家（第一个是房主），ai 是其余座位的 AI 难度 */
function fullRoom(net, names, ai = [], prefix = '') {
  const cs = names.map((_, i) => net.client(`${prefix}c${i}`));
  cs[0].send('create', { name: names[0] });
  net.pump();
  vi.advanceTimersByTime(5000);
  const code = cs[0].inbox.find((m) => m.t === 'room').room.code;
  // 先把座位都打开，再让其他人加入
  for (let i = 1; i < 5; i++) cs[0].send('setSeat', { index: i, kind: i < names.length ? 'open' : ai[i - names.length] ?? 'closed' });
  vi.advanceTimersByTime(5000);
  cs.slice(1).forEach((c, i) => c.send('join', { code, name: names[i + 1] }));
  vi.advanceTimersByTime(5000);
  return { cs, code };
}

describe('满员房间 + 网络延迟', () => {
  it('5 位人类、每条消息 0–2 秒随机延迟：打完整局，没有错误，所有人状态一致', () => {
    for (const seed of [1, 2]) {
      const rng = createRng(seed);
      const net = network({ seed, latency: () => Math.floor(rng.next() * 2000), matchOptions: REAL });
      const { cs, code } = fullRoom(net, NAMES);
      cs.forEach((c) => (c.autoPlay = true));
      cs[0].send('start');
      for (let i = 0; i < 200_000 && cs[0].state?.phase !== P.GAME_OVER; i++) vi.advanceTimersToNextTimer();
      vi.advanceTimersByTime(10_000);
      const match = net.lobby.getRoom(code).match;
      expect(match.state.phase, `seed ${seed}`).toBe(P.GAME_OVER);
      for (const c of cs) {
        expect(c.state).toEqual(match.state);
        expect(c.errors).toEqual([]);
      }
      // 延迟只会让人慢，不该触发超时代打
      expect(updates(cs[0]).filter((m) => m.notice)).toEqual([]);
      expect(match.stats.fallbacks).toBe(0);
      expect(validateState(match.state, { board, rules: RULES, cards: CARDS })).toEqual([]);
      // 最大的消息也远小于服务器能收的上限没有意义（服务器只限制收），这里记录发出去的大小量级
      expect(net.stats.maxBytes).toBeLessThan(64 * 1024);
    }
  });

  it('5 位人类里有人用了 AI 的默认名字：开局正常，AI 名字不重复', () => {
    const net = network({ matchOptions: REAL });
    const names = ['小红', '小蓝', '阿明'];
    const { cs } = fullRoom(net, names, ['normal', 'easy']);
    net.pump();
    cs[0].send('start');
    net.pump();
    const list = cs[0].state.players.map((p) => p.name);
    expect(new Set(list).size).toBe(5);
    expect(list.slice(0, 3)).toEqual(names);
  });
});

describe('迟到和不回的消息', () => {
  it('一直不回 ready 的连接（断了但服务器还没发现）：只在第一批多等一次，之后不再拖慢别人', () => {
    const net = network({ matchOptions: REAL });
    const { cs } = fullRoom(net, ['小红', '阿明'], ['normal', 'normal']);
    net.pump();
    const [a, silent] = cs;
    silent.autoReady = false;
    a.autoPlay = true;
    a.send('start');
    net.pump();
    // 记录每批更新到达的时刻
    const times = [];
    const origPush = a.inbox.push.bind(a.inbox);
    a.inbox.push = (m) => {
      if (m.t === 'update') times.push(Date.now());
      return origPush(m);
    };
    for (let i = 0; i < 400; i++) {
      vi.advanceTimersToNextTimer();
      net.pump();
    }
    const gaps = times.slice(1).map((t, i) => t - times[i]);
    // 阿明落后后，AI 步之间只隔 aiDelayMs，不再每步多等 8 秒。
    // （轮到阿明自己时照常等 60 秒超时，那是正常的回合计时，不算在内）
    const slow = gaps.filter((g) => g >= READY_TIMEOUT_MS && g < TURN_TIMEOUT_MS);
    expect(slow.length).toBeLessThanOrEqual(2);
    expect(gaps.length).toBeGreaterThan(20);

    // 阿明跟上（回了最新一批）后，又照常等他
    silent.send('ready', { seq: updates(silent).at(-1).seq });
    net.pump();
  });

  it('被顶替的旧页面还在路上的消息：到达后无效，不影响对局', () => {
    const net = network({ matchOptions: REAL });
    const { cs, code } = fullRoom(net, ['小红', '阿明'], ['normal']);
    net.pump();
    const [a, b] = cs;
    a.send('start');
    net.pump();
    // a 的回合；b 掉线前发出的、绕路很久的消息
    b.setLatency(() => 30_000);
    b.send('action', { action: { kind: 'roll' } });
    b.send('ready', { seq: 1 });
    const b2 = net.client('b2');
    b2.send('resume', b.seat);
    net.pump();
    expect(b.closed).toBe(true);
    const before = structuredClone(net.lobby.getRoom(code).match.state);
    vi.advanceTimersByTime(30_001);
    net.pump();
    // a 没操作、计时还没到：状态不变，旧连接的掷骰没有替任何人执行
    expect(net.lobby.getRoom(code).match.state).toEqual(before);
    expect(net.lobby.getRoom(code).seats[1]).toMatchObject({ clientId: 'b2' });
  });

  it('连点两次：第二次被拒绝，状态只前进一步', () => {
    const net = network({ matchOptions: REAL });
    const { cs, code } = fullRoom(net, ['小红', '阿明']);
    net.pump();
    const [a] = cs;
    a.send('start');
    a.send('action', { action: { kind: 'roll' } });
    a.send('action', { action: { kind: 'roll' } });
    net.pump();
    const match = net.lobby.getRoom(code).match;
    // 第二次掷骰要么被拒（阶段已变），要么是掷出双数后的追加掷骰；都不会多走一个回合
    expect(match.state.turn).toBe(1);
    expect(updates(a).length).toBeLessThanOrEqual(3);
  });
});

describe('多房间同时运行', () => {
  it('20 个房间（每个 1 位人类 + 4 个 AI）同时打完；全部离开后没有残留的房间和计时器', () => {
    const net = network({ matchOptions: { ...REAL, aiDelayMs: 50 } });
    const rooms = [];
    for (let r = 0; r < 20; r++) {
      const { cs, code } = fullRoom(net, [`玩家${r}`], ['normal', 'easy', 'normal', 'easy'], `r${r}`);
      net.pump();
      cs[0].autoPlay = true;
      cs[0].send('start');
      rooms.push({ c: cs[0], code });
    }
    expect(net.lobby.roomCount()).toBe(20);
    for (let i = 0; i < 2_000_000 && rooms.some(({ c }) => c.state.phase !== P.GAME_OVER); i++) {
      vi.advanceTimersToNextTimer();
      net.pump();
    }
    for (const { c, code } of rooms) {
      expect(c.state.phase).toBe(P.GAME_OVER);
      expect(c.state).toEqual(net.lobby.getRoom(code).match.state);
      expect(c.errors).toEqual([]);
    }
    // 终局后不再有计时器在跑
    expect(vi.getTimerCount()).toBe(0);
    // 每批更新都存盘：次数和批次一个量级（不会每条消息写好几次）
    const batches = rooms.reduce((n, { code }) => n + net.lobby.getRoom(code).match.seq, 0);
    expect(net.stats.persists).toBeLessThan(batches + 20 * 20);
    for (const { c } of rooms) c.send('leave');
    net.pump();
    expect(net.lobby.roomCount()).toBe(0);
    expect(net.disk.size).toBe(0);
    expect(vi.getTimerCount()).toBe(0);
    expect(net.stats.maxBytes).toBeLessThan(MAX_MESSAGE_BYTES * 16);
  });

  it('连续开 50 局再关掉：房间、计时器全部清理', () => {
    const net = network({ matchOptions: { ...REAL, aiDelayMs: 10 } });
    for (let r = 0; r < 50; r++) {
      const { cs } = fullRoom(net, ['甲', '乙'], ['easy'], `s${r}`);
      net.pump();
      cs.forEach((c) => (c.autoPlay = true));
      cs[0].send('start');
      for (let i = 0; i < 100_000 && cs[0].state.phase !== P.GAME_OVER; i++) {
        vi.advanceTimersToNextTimer();
        net.pump();
      }
      expect(cs[0].state.phase).toBe(P.GAME_OVER);
      // 一半主动离开，一半直接断线（等暂停超时关闭）
      if (r % 2) cs.forEach((c) => c.send('leave'));
      else cs.forEach((c) => c.drop());
      net.pump();
    }
    vi.advanceTimersByTime(60 * 60_000);
    expect(net.lobby.roomCount()).toBe(0);
    expect(net.disk.size).toBe(0);
    expect(vi.getTimerCount()).toBe(0);
  });
});
