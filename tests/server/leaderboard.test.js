/**
 * 联网服务器：排行榜 HTTP 接口。起一个真的 HTTP 服务器（随机端口、临时目录），按网页的方式请求。
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createServer } from 'node:http';
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createScoresApi, MAX_BODY_BYTES, SUBMITS_PER_HOUR } from '../../server/leaderboard.js';
import { TILES, GROUPS } from '../../src/data/config/board.js';
import { RULES } from '../../src/data/config/rules.js';
import { CARDS } from '../../src/data/config/cards.js';
import { rulesFor } from '../../src/data/config/modes.js';
import { createBoard } from '../../src/logic/core/board.js';
import { createGame } from '../../src/logic/core/game.js';
import { createInitialState } from '../../src/logic/core/gameState.js';
import { createEventBus } from '../../src/logic/core/eventBus.js';
import { performAction } from '../../src/logic/core/actions.js';
import { recordAction } from '../../src/logic/core/actionLog.js';
import { challengeScore } from '../../src/logic/core/results.js';
import { createAiDriver } from '../../src/logic/ai/driver.js';
import { decideAction } from '../../src/logic/ai/strategy.js';
import { createRng } from '../../src/logic/utils/rng.js';
import { challengePlayers, dailyChallenge, encodeChallenge } from '../../src/logic/systems/challenge.js';

const board = createBoard({ tiles: TILES, groups: GROUPS, rules: RULES });
const NOW = Date.parse('2026-11-03T10:00:00Z');
const TODAY = '2026-11-03';
const FB = [{ kind: 'endTurn' }, { kind: 'roll' }, { kind: 'decline' }, { kind: 'rejectTrade' }, { kind: 'choose', index: 0 }, { kind: 'pass' }, { kind: 'payDebt' }, { kind: 'bankrupt' }];

/** 打一局每日挑战，返回挑战码、操作记录和本机算出的成绩 */
function playDaily(date, humanSeed = 1) {
  const cfg = dailyChallenge(date);
  const code = encodeChallenge(cfg);
  const players = challengePlayers(cfg.kinds);
  const rules = rulesFor(cfg.mode, players.length);
  const state = createInitialState({ board, rules, cards: CARDS, players, seed: cfg.seed, mode: cfg.mode, challenge: { code, daily: date } });
  const game = createGame({ board, rules, state, bus: createEventBus(), cards: CARDS });
  const driver = createAiDriver({ game, state, board, rules, cards: CARDS });
  const rng = createRng(humanSeed);
  while (state.phase !== 'gameOver') {
    if (driver.isAiTurn()) {
      driver.step();
      continue;
    }
    const me = game.actingPlayerId();
    for (const a of [decideAction({ state, board, rules, cards: CARDS }, me, { level: 'normal', rng }), ...FB]) {
      if (a && performAction(game, a).ok) {
        recordAction(state, a);
        break;
      }
    }
  }
  return { code, actions: state.actionLog, score: challengeScore({ state, board }) };
}
const played = playDaily(TODAY);

let dir;
let server;
let base;
let now;
let ip;

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), 'rg-scores-'));
  now = NOW;
  ip = '1.2.3.4';
  const api = createScoresApi({ dir, board, cards: CARDS, now: () => now, ipOf: () => ip, log: () => {} });
  server = createServer((req, res) => {
    if (!api.handle(req, res)) res.writeHead(404).end();
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${server.address().port}`;
});
afterEach(async () => {
  await new Promise((r) => server.close(r));
  rmSync(dir, { recursive: true, force: true });
});

const deviceId = (n = 1) => `device-${String(n).padStart(12, '0')}`;
function post(body, headers = {}) {
  return fetch(`${base}/api/scores`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Origin: base, ...headers },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  });
}
const submit = (over = {}) => post({ code: played.code, actions: played.actions, name: '小红', deviceId: deviceId(), ...over });

describe('交成绩', () => {
  it('服务器重放算出成绩、上榜、写盘；GET 能看到', async () => {
    const res = await submit();
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toMatchObject({ ok: true, date: TODAY, rank: 1, total: 1, improved: true, score: played.score });
    expect(body.entryId).toMatch(/^[\w-]{16}$/);
    expect(readdirSync(dir)).toEqual([`${TODAY}.json`]);

    const list = await (await fetch(`${base}/api/scores?date=${TODAY}`)).json();
    expect(list).toEqual({ date: TODAY, total: 1, entries: [{ rank: 1, entryId: body.entryId, name: '小红', score: played.score }] });
    // 公开数据和文件里都没有原始设备标识
    expect(JSON.stringify(list)).not.toContain(deviceId());
    expect(readFileSync(join(dir, `${TODAY}.json`), 'utf8')).not.toContain(deviceId());
  });

  it('同一设备再交：成绩没进步不变，换设备算新的一人', async () => {
    const first = await (await submit()).json();
    const again = await (await submit({ name: '改名了' })).json();
    expect(again).toMatchObject({ rank: 1, total: 1, improved: false, entryId: first.entryId });
    const other = playDaily(TODAY, 2);
    const b = await (await submit({ deviceId: deviceId(2), actions: other.actions })).json();
    expect(b.total).toBe(2);
    const list = await (await fetch(`${base}/api/scores?date=${TODAY}`)).json();
    expect(list.entries.map((e) => e.name)).toContain('改名了');
  });

  it('改过的记录核实失败（422），不上榜', async () => {
    const res = await submit({ actions: played.actions.slice(0, -1) });
    expect(res.status).toBe(422);
    expect((await res.json()).error).toMatch(/^成绩核实失败/);
    const list = await (await fetch(`${base}/api/scores?date=${TODAY}`)).json();
    expect(list.total).toBe(0);
  });

  it('交上来的成绩字段被忽略，只认重放结果', async () => {
    const body = await (await submit({ score: { rank: 1, players: 4, bankrupt: false, netWorth: 999999, round: 1 } })).json();
    expect(body.score).toEqual(played.score);
  });

  it('只收前后一天的每日挑战；普通挑战码不收', async () => {
    now = Date.parse('2026-11-05T10:00:00Z');
    expect((await submit()).status).toBe(422);
    now = Date.parse('2026-11-04T10:00:00Z');
    expect((await submit()).status).toBe(200);
    const plain = encodeChallenge({ mode: 'quick', kinds: ['human', 'normal', 'normal', 'normal'], seed: 1 });
    const res = await submit({ code: plain });
    expect(res.status).toBe(422);
  });

  it.each([
    ['没有昵称', { name: '  ' }, 400],
    ['设备标识太短', { deviceId: 'abc' }, 400],
    ['设备标识有怪字符', { deviceId: '../../etc/passwd/xxxxxxxx' }, 400],
  ])('%s → %s', async (_, over, status) => {
    expect((await submit(over)).status).toBe(status);
  });

  it('不是 JSON、太大、别的网站、方法不对', async () => {
    expect((await post('{oops')).status).toBe(400);
    expect((await post('[]')).status).toBe(400);
    expect((await post('x'.repeat(MAX_BODY_BYTES + 1))).status).toBe(413);
    expect((await post({}, { Origin: 'http://evil.example' })).status).toBe(403);
    expect((await post({}, { 'Content-Type': 'text/plain' })).status).toBe(415);
    expect((await fetch(`${base}/api/scores`, { method: 'DELETE' })).status).toBe(405);
  });

  it(`每个 IP 每小时最多 ${SUBMITS_PER_HOUR} 次；换 IP 不受影响，一小时后恢复`, async () => {
    for (let i = 0; i < SUBMITS_PER_HOUR; i++) expect((await submit({ name: '' })).status).toBe(400);
    expect((await submit()).status).toBe(429);
    ip = '5.6.7.8';
    expect((await submit()).status).toBe(200);
    ip = '1.2.3.4';
    now += 3_600_000;
    expect((await submit()).status).toBe(200);
  });
});

describe('看榜', () => {
  it('日期格式不对 400；没人上榜是空榜；过期的日期是空榜', async () => {
    expect((await fetch(`${base}/api/scores?date=11-03`)).status).toBe(400);
    expect(await (await fetch(`${base}/api/scores?date=${TODAY}`)).json()).toEqual({ date: TODAY, total: 0, entries: [] });
    expect((await (await fetch(`${base}/api/scores?date=2026-01-01`)).json()).total).toBe(0);
  });

  it('损坏的榜单文件按空榜处理，不报错', async () => {
    writeFileSync(join(dir, '2026-11-02.json'), '{"date":"2026-11-02","entries":"bad"}');
    expect(await (await fetch(`${base}/api/scores?date=2026-11-02`)).json()).toEqual({ date: '2026-11-02', total: 0, entries: [] });
  });
});
