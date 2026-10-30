/**
 * 联网服务器：同一个端口上提供网页（dist/）和 WebSocket（/ws）。
 * 房间规则在 src/logic/net/room.js，这里只负责连接、限流、消息检查和静态文件。
 *
 * 用法：npm run server（先构建再启动）。环境变量 PORT（默认 8787）、HOST（默认 0.0.0.0，即局域网可访问）。
 */
import { createServer } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { networkInterfaces } from 'node:os';
import { extname, join, normalize, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomInt, randomUUID } from 'node:crypto';
import { WebSocketServer } from 'ws';
import { createLobby } from '../src/logic/net/room.js';
import { createRateLimiter } from '../src/logic/net/rateLimit.js';
import { MAX_MESSAGE_BYTES, parseClientMessage } from '../src/logic/net/protocol.js';

const PORT = Number(process.env.PORT ?? 8787);
const HOST = process.env.HOST ?? '0.0.0.0';
const DIST = fileURLToPath(new URL('../dist/', import.meta.url));
/** 每个连接：平均每秒 10 条，最多连发 30 条；超出直接断开 */
const RATE = { capacity: 30, perSecond: 10 };
/** 同一个 IP 最多同时连几个（同一台电脑开多个标签页也要能玩） */
const MAX_CONNECTIONS_PER_IP = 8;
const HEARTBEAT_MS = 30_000;

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.json': 'application/json',
  '.ico': 'image/x-icon',
};

/** 只读 dist/ 里的文件；路径解析后必须仍在 dist/ 下，防止 ../ 越界 */
async function serveStatic(req, res) {
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    res.writeHead(405).end();
    return;
  }
  let path;
  try {
    path = decodeURIComponent(new URL(req.url, 'http://x').pathname);
  } catch {
    res.writeHead(400).end();
    return;
  }
  const file = normalize(join(DIST, path.endsWith('/') ? `${path}index.html` : path));
  if (!file.startsWith(DIST.endsWith(sep) ? DIST : DIST + sep)) {
    res.writeHead(403).end();
    return;
  }
  try {
    if (!(await stat(file)).isFile()) throw new Error('not a file');
    const body = await readFile(file);
    res.writeHead(200, {
      'Content-Type': TYPES[extname(file)] ?? 'application/octet-stream',
      'X-Content-Type-Options': 'nosniff',
    });
    res.end(req.method === 'HEAD' ? undefined : body);
  } catch {
    const missing = path === '/' || path === '/index.html';
    res.writeHead(missing ? 503 : 404, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end(missing ? '还没有构建网页，请先运行 npm run build' : '找不到文件');
  }
}

const http = createServer(serveStatic);
const wss = new WebSocketServer({
  server: http,
  path: '/ws',
  maxPayload: MAX_MESSAGE_BYTES,
  // 只接受从本服务器打开的网页发起的连接（开发时经 Vite 代理，Origin 与 Host 同为 localhost:5173）
  verifyClient: ({ req }) => {
    const origin = req.headers.origin;
    if (!origin) return true;
    try {
      return new URL(origin).host === req.headers.host;
    } catch {
      return false;
    }
  },
});

/** @type {Map<string, import('ws').WebSocket>} */
const sockets = new Map();
const perIp = new Map();

const lobby = createLobby({
  randomInt: (max) => randomInt(max),
  send(clientId, msg) {
    const ws = sockets.get(clientId);
    if (ws && ws.readyState === ws.OPEN) ws.send(JSON.stringify(msg));
  },
});

wss.on('connection', (ws, req) => {
  const ip = req.socket.remoteAddress ?? '?';
  if ((perIp.get(ip) ?? 0) >= MAX_CONNECTIONS_PER_IP) {
    ws.close(1008, 'too many connections');
    return;
  }
  perIp.set(ip, (perIp.get(ip) ?? 0) + 1);

  const id = randomUUID();
  const limiter = createRateLimiter({ ...RATE, now: Date.now });
  sockets.set(id, ws);
  ws.isAlive = true;
  ws.on('pong', () => (ws.isAlive = true));
  // 超长消息、坏帧等协议错误会触发 error（随后自动关闭连接）；没有监听器时整个服务器会崩溃
  ws.on('error', () => {});

  ws.on('message', (data, isBinary) => {
    if (!limiter.take()) {
      ws.close(1008, 'rate limit');
      return;
    }
    const parsed = parseClientMessage(isBinary ? null : data.toString('utf8'));
    if (!parsed.ok) {
      ws.send(JSON.stringify({ t: 'error', message: parsed.error }));
      return;
    }
    try {
      lobby.handle(id, parsed.msg);
    } catch (err) {
      // 逻辑层不该抛错；万一抛了，只拒绝这一条，不让整个服务器挂掉
      console.error('处理消息出错', err);
      ws.send(JSON.stringify({ t: 'error', message: '服务器出错了' }));
    }
  });

  ws.on('close', () => {
    sockets.delete(id);
    const n = (perIp.get(ip) ?? 1) - 1;
    if (n > 0) perIp.set(ip, n);
    else perIp.delete(ip);
    lobby.disconnect(id);
  });
});

// 定时 ping，断网没发 close 的连接两次没回应就清掉
const heartbeat = setInterval(() => {
  for (const ws of wss.clients) {
    if (!ws.isAlive) ws.terminate();
    else {
      ws.isAlive = false;
      ws.ping();
    }
  }
}, HEARTBEAT_MS);
wss.on('close', () => clearInterval(heartbeat));

http.listen(PORT, HOST, () => {
  console.log(`城市大富翁联网服务器已启动，端口 ${PORT}`);
  console.log(`  本机：http://localhost:${PORT}/`);
  if (HOST === '0.0.0.0') {
    for (const list of Object.values(networkInterfaces())) {
      for (const a of list ?? []) if (a.family === 'IPv4' && !a.internal) console.log(`  局域网：http://${a.address}:${PORT}/`);
    }
  }
});
