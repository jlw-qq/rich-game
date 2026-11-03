/**
 * 逻辑层：按 IP 限制连接数时，判断连接来自哪个 IP（clientIp）。
 */
import { describe, it, expect } from 'vitest';
import { clientIp, isLoopback, normalizeIp } from '../../../src/logic/net/clientIp.js';

describe('IP 写法', () => {
  it('IPv6 包着的 IPv4 还原成 IPv4，其他原样', () => {
    expect(normalizeIp('::ffff:203.0.113.5')).toBe('203.0.113.5');
    expect(normalizeIp('::FFFF:127.0.0.1')).toBe('127.0.0.1');
    expect(normalizeIp(' 2001:db8::1 ')).toBe('2001:db8::1');
    expect(normalizeIp(undefined)).toBe('');
  });

  it('本机回环：127.x.x.x、::1、::ffff:127.0.0.1', () => {
    expect(isLoopback('127.0.0.1')).toBe(true);
    expect(isLoopback('127.8.9.10')).toBe(true);
    expect(isLoopback('::1')).toBe(true);
    expect(isLoopback('::ffff:127.0.0.1')).toBe(true);
    expect(isLoopback('10.0.0.1')).toBe(false);
    expect(isLoopback('1270.0.0.1')).toBe(false);
  });
});

describe('连接来自哪个 IP', () => {
  const viaProxy = (forwardedFor) => clientIp({ remoteAddress: '::ffff:127.0.0.1', forwardedFor, trustProxy: true });

  it('不开 trustProxy：忽略 X-Forwarded-For，用连接本身的地址', () => {
    expect(clientIp({ remoteAddress: '::ffff:127.0.0.1', forwardedFor: '203.0.113.5' })).toBe('127.0.0.1');
    expect(clientIp({ remoteAddress: '198.51.100.7', forwardedFor: '203.0.113.5' })).toBe('198.51.100.7');
  });

  it('开了 trustProxy、连接来自本机代理：取最右边一项', () => {
    expect(viaProxy('203.0.113.5')).toBe('203.0.113.5');
    // 玩家自己带了一个伪造的头，代理在后面追加真实地址
    expect(viaProxy('1.1.1.1, 203.0.113.5')).toBe('203.0.113.5');
    expect(viaProxy(['1.1.1.1', '203.0.113.5'])).toBe('203.0.113.5');
    expect(viaProxy('::ffff:203.0.113.5')).toBe('203.0.113.5');
    expect(viaProxy('2001:db8::1')).toBe('2001:db8::1');
  });

  it('开了 trustProxy，但连接不是来自本机：外网直连伪造的头不算', () => {
    expect(clientIp({ remoteAddress: '198.51.100.7', forwardedFor: '203.0.113.5', trustProxy: true })).toBe('198.51.100.7');
  });

  it('头为空、带端口或乱写时，退回连接本身的地址', () => {
    expect(viaProxy(undefined)).toBe('127.0.0.1');
    expect(viaProxy('')).toBe('127.0.0.1');
    expect(viaProxy('203.0.113.5, ')).toBe('127.0.0.1');
    expect(viaProxy('203.0.113.5:4567')).toBe('127.0.0.1');
    expect(viaProxy('unknown')).toBe('127.0.0.1');
  });

  it('什么地址都没有时为 ?', () => {
    expect(clientIp({})).toBe('?');
  });
});
