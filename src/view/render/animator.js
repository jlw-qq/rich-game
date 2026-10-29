/**
 * 表现层：动画排队器。逻辑层的事件是同步发出的，这里按顺序逐个播放：
 * 每个事件开始播放时调用 onEvent（写日志、放音效），播完再处理下一个。
 * 只维护“显示用”的棋子位置、骰子和飘字，不修改游戏状态。
 */
import { gridOf } from './layout.js';

const STEP_MS = 160;
const MAX_MOVE_MS = 2400;
const DICE_MS = 600;
const JAIL_MS = 500;
const FLOAT_MS = 1200;

const lerp = (a, b, t) => a + (b - a) * t;
const randomFace = () => 1 + Math.floor(Math.random() * 6);

/** 事件 → 涉及的金额变化，用于飘字 */
const CASH_DELTAS = {
  cashGained: (p) => [[p.playerId, p.amount]],
  passedStart: (p) => [[p.playerId, p.amount]],
  propertyBought: (p) => [[p.playerId, -p.price]],
  propertyUpgraded: (p) => [[p.playerId, -p.cost]],
  propertyRedeemed: (p) => [[p.playerId, -p.cost]],
  buildingSold: (p) => [[p.playerId, p.refund]],
  propertyMortgaged: (p) => [[p.playerId, p.amount]],
  tradeAccepted: ({ trade: t }) => [
    [t.fromId, t.take.cash - t.give.cash],
    [t.toId, t.give.cash - t.take.cash],
  ],
  paymentMade: (p) => {
    const share = p.payeeIds.length > 0 ? Math.floor(p.amount / p.payeeIds.length) : 0;
    return [[p.payerId, -p.amount], ...p.payeeIds.map((id) => [id, share])];
  },
};

/**
 * @param {{
 *   state: { players: { id: string, position: number }[] },
 *   reducedMotion?: boolean,
 *   onEvent?: (type: string, payload: object) => void,
 *   onChange?: () => void,
 *   onIdle?: () => void,
 * }} options
 */
export function createAnimator({ state, reducedMotion = false, onEvent = () => {}, onChange = () => {}, onIdle = () => {} }) {
  const tokens = new Map(state.players.map((p) => [p.id, { ...gridOf(p.position), z: 0 }]));
  const dice = { values: [1, 1], rolling: false };
  const queue = [];
  let current = null;
  let floaters = [];
  let lastNow = 0;
  let pendingIdle = false;
  /** 播放倍速：动画时长除以该值 */
  let speed = 1;

  const duration = (ms) => (reducedMotion ? 0 : ms / speed);

  /** 事件总线监听器，签名与 bus.on 一致 */
  function handle(payload, type) {
    queue.push({ type, payload });
    pendingIdle = true;
    onChange();
  }

  function addFloater(playerId, amount) {
    const tok = tokens.get(playerId);
    if (!tok || amount === 0) return;
    floaters.push({
      text: `${amount > 0 ? '+' : '−'}${Math.abs(amount)}`,
      color: amount > 0 ? '#7cfc9a' : '#ff8a80',
      gx: tok.gx,
      gy: tok.gy,
      born: lastNow,
    });
  }

  /** 事件开始播放时创建动画任务；返回 null 表示没有动画 */
  function makeTask(type, p) {
    for (const [id, amount] of CASH_DELTAS[type]?.(p) ?? []) addFloater(id, amount);

    switch (type) {
      case 'diceRolled':
        return {
          duration: duration(DICE_MS),
          update(t) {
            dice.rolling = t < 1;
            dice.values = t < 1 ? [randomFace(), randomFace()] : [...p.dice];
          },
        };

      case 'playerMoved': {
        const tok = tokens.get(p.playerId);
        const n = p.path.length;
        if (!tok || n === 0) return null;
        const points = [p.from, ...p.path].map(gridOf);
        return {
          duration: duration(Math.min(n * STEP_MS, MAX_MOVE_MS)),
          update(t) {
            const f = t * n;
            const i = Math.min(Math.floor(f), n - 1);
            const u = f - i;
            tok.gx = lerp(points[i].gx, points[i + 1].gx, u);
            tok.gy = lerp(points[i].gy, points[i + 1].gy, u);
            tok.z = t < 1 ? Math.sin(Math.PI * u) * 0.3 : 0;
          },
        };
      }

      case 'sentToJail': {
        const tok = tokens.get(p.playerId);
        if (!tok) return null;
        const from = { gx: tok.gx, gy: tok.gy };
        const to = gridOf(p.to);
        return {
          duration: duration(JAIL_MS),
          update(t) {
            tok.gx = lerp(from.gx, to.gx, t);
            tok.gy = lerp(from.gy, to.gy, t);
            tok.z = t < 1 ? Math.sin(Math.PI * t) * 1.2 : 0;
          },
        };
      }

      default:
        return null;
    }
  }

  /**
   * 推进动画到 now（毫秒）。返回是否还需要下一帧。
   * @param {number} now
   */
  function tick(now) {
    lastNow = now;
    for (;;) {
      if (!current) {
        const next = queue.shift();
        if (!next) break;
        onEvent(next.type, next.payload);
        const task = makeTask(next.type, next.payload);
        if (!task) continue;
        current = { ...task, start: now };
      }
      const t = current.duration > 0 ? Math.min(1, (now - current.start) / current.duration) : 1;
      current.update(t);
      if (t < 1) break;
      current = null;
    }

    floaters = floaters.filter((f) => now - f.born < FLOAT_MS);
    const busy = current !== null || queue.length > 0;
    if (!busy && pendingIdle) {
      pendingIdle = false;
      onIdle();
    }
    return busy || floaters.length > 0;
  }

  return {
    handle,
    tick,
    tokens,
    dice,
    /** @param {number} value 播放倍速，正数；只影响之后开始的动画 */
    setSpeed(value) {
      if (Number.isFinite(value) && value > 0) speed = value;
    },
    /** 是否还有事件在播放或排队 */
    get busy() {
      return current !== null || queue.length > 0;
    },
    /** 当前可见的飘字，rise 为上升高度（格高为单位），alpha 为透明度 */
    get floaters() {
      return floaters.map((f) => {
        const age = Math.min(1, (lastNow - f.born) / FLOAT_MS);
        return { text: f.text, color: f.color, gx: f.gx, gy: f.gy, rise: reducedMotion ? 0 : age * 0.8, alpha: 1 - age * age };
      });
    },
  };
}
