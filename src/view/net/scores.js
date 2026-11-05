/**
 * 表现层：每日挑战排行榜的网络请求和本机记录（设备标识、上次用的昵称、每天在榜上的那一条）。
 * 服务器连不上（比如只开了 npm run dev）时返回错误，不抛异常。
 */
const DEVICE_KEY = 'rich-game:device-id';
const NICKNAME_KEY = 'rich-game:nickname';
const ENTRY_KEY = 'rich-game:board-entries';
const TIMEOUT_MS = 10_000;

/** @param {Storage | null} storage */
export function createScoresClient(storage) {
  const get = (k) => {
    try {
      return storage?.getItem(k) ?? null;
    } catch {
      return null;
    }
  };
  const set = (k, v) => {
    try {
      storage?.setItem(k, v);
    } catch {
      // 存不下只影响下次的默认值和高亮
    }
  };

  /** 本机的随机设备标识：同一台设备一天只留最好的一次。存不下时每次打开页面都是新设备 */
  let memoryDevice = null;
  function deviceId() {
    const saved = get(DEVICE_KEY);
    if (saved && /^[A-Za-z0-9_-]{16,64}$/.test(saved)) return saved;
    if (!memoryDevice) {
      // getRandomValues 在 http 页面上也能用（randomUUID 只在 https 下有）
      const bytes = new Uint8Array(18);
      crypto.getRandomValues(bytes);
      memoryDevice = btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
    }
    set(DEVICE_KEY, memoryDevice);
    return memoryDevice;
  }

  function entries() {
    try {
      const v = JSON.parse(get(ENTRY_KEY) ?? '{}');
      return v && typeof v === 'object' && !Array.isArray(v) ? v : {};
    } catch {
      return {};
    }
  }

  async function request(url, init) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
    try {
      const res = await fetch(url, { ...init, signal: ctrl.signal });
      const body = await res.json().catch(() => null);
      // 没有 JSON：多半是开发服务器转发失败（没开 npm run server）或中间的代理出错
      if (!body) return { ok: false, error: '排行榜暂时连不上' };
      if (!res.ok) return { ok: false, error: body.error ?? `服务器返回 ${res.status}` };
      return { ok: true, ...body };
    } catch {
      return { ok: false, error: '排行榜暂时连不上' };
    } finally {
      clearTimeout(timer);
    }
  }

  return {
    nickname: () => get(NICKNAME_KEY) ?? '',
    /** 这一天本机在榜上的那一条（用来高亮），没交过为 null */
    entryFor: (date) => (typeof entries()[date] === 'string' ? entries()[date] : null),

    /** @param {string} date */
    load: (date) => request(`/api/scores?date=${encodeURIComponent(date)}`),

    /**
     * @param {{ code: string, actions: object[], name: string }} submission
     * @returns {Promise<{ ok: true, date: string, entryId: string, rank: number | null, total: number, improved: boolean, score: object } | { ok: false, error: string }>}
     */
    async submit({ code, actions, name }) {
      set(NICKNAME_KEY, name);
      const r = await request('/api/scores', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ code, actions, name, deviceId: deviceId() }),
      });
      if (r.ok) {
        const all = entries();
        all[r.date] = r.entryId;
        // 只留最近 40 天
        const keep = Object.keys(all).sort().slice(-40);
        set(ENTRY_KEY, JSON.stringify(Object.fromEntries(keep.map((k) => [k, all[k]]))));
      }
      return r;
    },
  };
}
