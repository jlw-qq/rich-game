/**
 * 联网服务器：每日挑战排行榜的 HTTP 接口和存盘。
 *
 *   GET  /api/scores?date=YYYY-MM-DD   这一天的前 50 名
 *   POST /api/scores                   交一局：{ code, actions, name, deviceId }
 *
 * 交上来的只是挑战码和人类玩家的操作记录，成绩由服务器重放算出（src/logic/systems/replay.js），改不了。
 * 只收每日挑战（日期与服务器 UTC 日期相差不超过一天）。榜单每天一个文件，写入时先写临时文件再改名。
 */
import { mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { replayChallenge } from '../src/logic/systems/replay.js';
import { dailyChallenge, encodeChallenge, isDateKey } from '../src/logic/systems/challenge.js';
import { createRateLimiter } from '../src/logic/net/rateLimit.js';
import {
  checkBoard,
  cleanNickname,
  emptyBoard,
  isAcceptedDate,
  isExpired,
  publicBoard,
  submitScore,
  utcDateKey,
} from '../src/logic/systems/leaderboard.js';

/** 请求体上限：2000 步操作记录约 60 KB */
export const MAX_BODY_BYTES = 64 * 1024;
/** 每个 IP 每小时最多交几次 */
export const SUBMITS_PER_HOUR = 10;
const FILE = /^(\d{4}-\d{2}-\d{2})\.json$/;
const DEVICE_ID = /^[A-Za-z0-9_-]{16,64}$/;

/**
 * @param {{ dir: string, board: object, cards: object[], now?: () => number, ipOf: (req: object) => string, log?: (msg: string) => void }} options
 *   ipOf：取请求方 IP（和 WebSocket 一样，按 TRUST_PROXY 决定信不信 X-Forwarded-For）
 * @returns {{ handle: (req: object, res: object) => boolean, prune: () => void }} handle 返回 false 表示不是排行榜的请求
 */
export function createScoresApi({ dir, board, cards, now = Date.now, ipOf, log = console.log }) {
  mkdirSync(dir, { recursive: true });
  /** 日期 → 榜单（读过一次就留在内存里） */
  const boards = new Map();
  /** IP → 限流器 */
  const limiters = new Map();

  function load(date) {
    if (boards.has(date)) return boards.get(date);
    let b = emptyBoard(date);
    try {
      const checked = checkBoard(JSON.parse(readFileSync(join(dir, `${date}.json`), 'utf8')), date);
      if (checked) b = checked;
      else log(`排行榜 ${date} 文件格式不对，按空榜处理`);
    } catch (err) {
      if (err.code !== 'ENOENT') log(`排行榜 ${date} 读不了：${err.message}`);
    }
    boards.set(date, b);
    return b;
  }

  function save(b) {
    const file = join(dir, `${b.date}.json`);
    writeFileSync(`${file}.tmp`, JSON.stringify(b));
    renameSync(`${file}.tmp`, file);
    boards.set(b.date, b);
  }

  /** 删掉过了保留期的榜单 */
  function prune() {
    const t = now();
    for (const name of readdirSync(dir)) {
      const m = FILE.exec(name);
      if (m && isExpired(m[1], t)) rmSync(join(dir, name), { force: true });
    }
    for (const date of boards.keys()) if (isExpired(date, t)) boards.delete(date);
    // 一小时没动静的限流器已经回满，删掉省内存
    for (const [ip, l] of limiters) if (t - l.last > 3_600_000) limiters.delete(ip);
  }

  function limited(ip) {
    let l = limiters.get(ip);
    if (!l) {
      l = { last: now(), limiter: createRateLimiter({ capacity: SUBMITS_PER_HOUR, perSecond: SUBMITS_PER_HOUR / 3600, now }) };
      limiters.set(ip, l);
    }
    l.last = now();
    return !l.limiter.take();
  }

  function send(res, status, body) {
    res.writeHead(status, {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff',
    });
    res.end(JSON.stringify(body));
  }
  const error = (res, status, message) => send(res, status, { ok: false, error: message });

  /** 只接受本站网页发来的提交（和 WebSocket 的 Origin 检查一样） */
  function sameOrigin(req) {
    const origin = req.headers.origin;
    if (!origin) return true;
    try {
      return new URL(origin).host === req.headers.host;
    } catch {
      return false;
    }
  }

  /** 挑战码对应的每日挑战日期（只认服务器前后一天内的） */
  function dailyDateOf(code) {
    const t = now();
    for (const date of new Set([utcDateKey(t - 86_400_000), utcDateKey(t), utcDateKey(t + 86_400_000)])) {
      if (encodeChallenge(dailyChallenge(date)) === code) return date;
    }
    return null;
  }

  function submit(body) {
    if (!body || typeof body !== 'object' || Array.isArray(body)) return { status: 400, error: '请求格式不对' };
    if (typeof body.deviceId !== 'string' || !DEVICE_ID.test(body.deviceId)) return { status: 400, error: '设备标识无效' };
    const name = cleanNickname(body.name);
    if (!name) return { status: 400, error: '请填写昵称' };
    const replay = replayChallenge({ board, cards }, { code: body.code, actions: body.actions });
    if (!replay.ok) return { status: 422, error: `成绩核实失败：${replay.error}` };
    const date = dailyDateOf(replay.code);
    if (!date || !isAcceptedDate(date, now())) return { status: 422, error: '只收今天（或昨天）的每日挑战' };

    const entryId = createHash('sha256').update(`rich-game:${body.deviceId}`).digest('base64url').slice(0, 16);
    const before = load(date);
    const r = submitScore(before, { entryId, name, score: replay.score, at: now() });
    // 成绩没进步、昵称也没变时榜单不变，不用写盘
    if (r.board.entries !== before.entries) save(r.board);
    return { status: 200, body: { ok: true, date, entryId, rank: r.rank, total: r.board.total, improved: r.improved, score: r.best.score } };
  }

  function readBody(req, res, done) {
    let size = 0;
    const chunks = [];
    let aborted = false;
    req.on('data', (chunk) => {
      if (aborted) return;
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        aborted = true;
        error(res, 413, '提交的内容太大');
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      if (aborted) return;
      let body;
      try {
        body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      } catch {
        error(res, 400, '请求不是合法的 JSON');
        return;
      }
      done(body);
    });
    req.on('error', () => {});
  }

  function handle(req, res) {
    let url;
    try {
      url = new URL(req.url, 'http://x');
    } catch {
      return false;
    }
    if (url.pathname !== '/api/scores') return false;

    if (req.method === 'GET') {
      const date = url.searchParams.get('date');
      if (!isDateKey(date)) error(res, 400, '日期格式应为 YYYY-MM-DD');
      else if (isExpired(date, now())) send(res, 200, publicBoard(emptyBoard(date)));
      else send(res, 200, publicBoard(load(date)));
      return true;
    }
    if (req.method !== 'POST') {
      res.writeHead(405, { Allow: 'GET, POST' }).end();
      return true;
    }
    if (!sameOrigin(req)) {
      error(res, 403, '只能从本站网页提交');
      return true;
    }
    if (!String(req.headers['content-type'] ?? '').startsWith('application/json')) {
      error(res, 415, '请用 JSON 提交');
      return true;
    }
    if (limited(ipOf(req))) {
      error(res, 429, `提交太频繁了，每小时最多 ${SUBMITS_PER_HOUR} 次`);
      return true;
    }
    readBody(req, res, (body) => {
      try {
        const r = submit(body);
        if (r.error) error(res, r.status, r.error);
        else send(res, r.status, r.body);
      } catch (err) {
        log(`排行榜提交出错：${err?.stack ?? err}`);
        error(res, 500, '服务器出错了');
      }
    });
    return true;
  }

  prune();
  return { handle, prune };
}
