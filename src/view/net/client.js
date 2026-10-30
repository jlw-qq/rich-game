/**
 * 表现层：和联网服务器的连接。网页由服务器提供（或开发时经 Vite 代理），所以连同一个地址的 /ws。
 */
import { PROTOCOL_VERSION } from '../../logic/net/protocol.js';

/** 连接被服务器拒绝或断开时给玩家看的原因 */
const CLOSE_REASONS = {
  'rate limit': '操作太频繁，连接被断开',
  'too many connections': '这台设备打开的连接太多了',
};

/**
 * @param {{ onMessage: (msg: object) => void, onClose: (reason: string) => void }} handlers
 * @returns {Promise<{ send: (msg: object) => void, close: () => void }>} 连不上时 reject，错误信息可直接显示
 */
export function connect({ onMessage, onClose }) {
  const url = `${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/ws`;
  return new Promise((resolve, reject) => {
    let ws;
    try {
      ws = new WebSocket(url);
    } catch {
      reject(new Error('无法连接联网服务器'));
      return;
    }
    let opened = false;
    let closedByUs = false;
    ws.addEventListener('open', () => {
      opened = true;
      resolve({
        send: (msg) => ws.readyState === WebSocket.OPEN && ws.send(JSON.stringify({ v: PROTOCOL_VERSION, ...msg })),
        close: () => {
          closedByUs = true;
          ws.close();
        },
      });
    });
    ws.addEventListener('message', (e) => {
      let msg;
      try {
        msg = JSON.parse(e.data);
      } catch {
        return;
      }
      if (msg && typeof msg === 'object') onMessage(msg);
    });
    ws.addEventListener('close', (e) => {
      if (!opened) reject(new Error('连不上联网服务器。联网对战需要用 npm run server 启动服务器，并从服务器的地址打开网页'));
      else if (!closedByUs) onClose(CLOSE_REASONS[e.reason] ?? '和服务器的连接断开了');
    });
  });
}
