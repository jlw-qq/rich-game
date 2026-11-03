/**
 * 表现层：复制和系统分享。剪贴板接口在非安全上下文（如局域网 http）或被拒绝时不可用，
 * 这时返回失败，由调用方提示手动复制。
 */

/**
 * @param {string} text
 * @returns {Promise<boolean>}
 */
export async function copyText(text) {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    return false;
  }
}

/** 手机等支持系统分享面板的浏览器 */
export const canShare = () => typeof navigator !== 'undefined' && typeof navigator.share === 'function';

/**
 * 有系统分享就用分享面板，否则复制链接。
 * @param {{ title: string, text: string, url: string }} data
 * @returns {Promise<'shared' | 'cancelled' | 'copied' | 'failed'>}
 */
export async function shareOrCopy(data) {
  if (canShare()) {
    try {
      await navigator.share(data);
      return 'shared';
    } catch (e) {
      // 用户关掉分享面板不算失败
      if (e?.name === 'AbortError') return 'cancelled';
    }
  }
  return (await copyText(data.url)) ? 'copied' : 'failed';
}

/** shareOrCopy 的结果 → 提示文字 */
export const SHARE_STATUS = {
  shared: '已分享',
  cancelled: '',
  copied: '链接已复制，发给朋友就行',
  failed: '复制失败，请手动选中链接复制',
};

/** 当前页面地址（不含查询参数）加上给定的查询字符串 */
export function pageUrl(query) {
  return `${location.origin}${location.pathname}?${query}`;
}
