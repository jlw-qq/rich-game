/**
 * 逻辑层：判断一条连接来自哪个 IP（按 IP 限制连接数要用）。
 * 服务器直接对外时就用连接本身的地址。放在本机的反向代理（如 Caddy）后面时，所有连接都来自 127.0.0.1，
 * 这时要从 X-Forwarded-For 里取真实地址——但这个请求头谁都能伪造，所以只在明确开启 trustProxy、
 * 且连接确实来自本机时才读，并且只取最右边一项（离服务器最近的那层代理写入的，也就是本机代理自己看到的对端）。
 */

/** 把 IPv6 里包着的 IPv4（::ffff:1.2.3.4）还原成 1.2.3.4，避免同一个人算成两个 IP */
export function normalizeIp(ip) {
  if (typeof ip !== 'string') return '';
  const s = ip.trim();
  return /^::ffff:\d{1,3}(\.\d{1,3}){3}$/i.test(s) ? s.slice(7) : s;
}

/** 是否为本机回环地址 */
export function isLoopback(ip) {
  const s = normalizeIp(ip);
  return s === '::1' || /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(s);
}

/** IPv4 或 IPv6 的字面量（只做粗查，挡住空值、端口号和明显的垃圾） */
const IP_LITERAL = /^(\d{1,3}(\.\d{1,3}){3}|[0-9a-f:]*:[0-9a-f:.]*)$/i;

/**
 * @param {{ remoteAddress?: string, forwardedFor?: string | string[], trustProxy?: boolean }} conn
 *   remoteAddress 为连接本身的对端地址；forwardedFor 为 X-Forwarded-For 请求头（Node 里重复的头会合并成逗号分隔的一行）
 * @returns {string} 用来计数的 IP；什么都拿不到时为 '?'
 */
export function clientIp({ remoteAddress, forwardedFor, trustProxy = false }) {
  const direct = normalizeIp(remoteAddress) || '?';
  if (!trustProxy || !isLoopback(direct) || forwardedFor === undefined) return direct;
  const header = Array.isArray(forwardedFor) ? forwardedFor.join(',') : String(forwardedFor);
  const last = normalizeIp(header.split(',').pop());
  return IP_LITERAL.test(last) ? last : direct;
}
