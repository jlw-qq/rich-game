/**
 * 表现层：动画排队器。逻辑层的事件是同步发出的，这里按顺序逐个播放：
 * 每个事件开始播放时调用 onEvent（写日志、放音效），播完再处理下一个。
 * 只维护“显示用”的棋子位置、骰子、飘字、落点和格子特效，不修改游戏状态。
 */
import { gridOf } from './layout.js';
import { diceBounce, easeInOut, popScale } from './easing.js';
import { POPUP_MS, TOAST_MS } from './popup.js';

export { easeInOut };

/** 每走一格的时长；整段路径最长 MAX_MOVE_MS，超过时每格按比例缩短 */
const STEP_MS = 160;
const MAX_MOVE_MS = 2400;
/** 棋子落地后的停顿，停顿结束才播放后续事件（买地、收租、抽卡等） */
export const LAND_PAUSE_MS = 120;
const DICE_MS = 600;
const JAIL_MS = 500;
const FLOAT_MS = 1200;
/** 落点高亮的持续时间，按播放倍速缩短 */
export const HIGHLIGHT_MS = 1200;
/** 高亮期间的脉冲次数 */
const PULSES = 2;
/** 同一格开始播放地产特效后，落点光边在该时长内淡出，避免多种强调叠在一起 */
const GLOW_HANDOFF_MS = 150;

/** 骰子落定后的弹跳时长；不阻塞后续事件，和棋子起步同时进行 */
export const DICE_BOUNCE_MS = 300;

/**
 * 地产事件 → 格子特效。返回 [tileId, kind, level?] 列表。
 * 特效只用于表现：买地闪色条、升级弹出建筑、卖建筑缩小、抵押变暗、赎回变亮。
 */
const TILE_EFFECTS = {
  propertyBought: (p) => [[p.tileId, 'buy']],
  propertyUpgraded: (p) => [[p.tileId, 'upgrade', p.level]],
  buildingSold: (p) => [[p.tileId, 'sell', p.level]],
  propertyMortgaged: (p) => [[p.tileId, 'mortgage']],
  propertyRedeemed: (p) => [[p.tileId, 'redeem']],
  // 交易换手的地产也闪色条，看清哪些格子换了主人
  tradeAccepted: ({ trade: t }) => [...t.give.properties, ...t.take.properties].map((id) => [id, 'buy']),
};

/** 各特效时长（毫秒），按播放倍速缩短 */
export const EFFECT_MS = { buy: 500, upgrade: 350, sell: 350, mortgage: 400, redeem: 400 };

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
 *   tileIds?: readonly string[],
 *   describePopup?: (type: string, payload: object) => object | null,
 *   reducedMotion?: boolean,
 *   onEvent?: (type: string, payload: object) => void,
 *   onChange?: () => void,
 *   onIdle?: () => void,
 * }} options tileIds 为按下标排列的格子 id，用来把地产特效对应到落点格；
 *   describePopup 把关键事件翻译成结果卡内容，返回 null 表示该事件不弹卡
 */
export function createAnimator({ state, tileIds = [], describePopup = () => null, reducedMotion = false, onEvent = () => {}, onChange = () => {}, onIdle = () => {} }) {
  const tokens = new Map(state.players.map((p) => [p.id, { ...gridOf(p.position), z: 0 }]));
  /** bounce：落定弹跳的上抬和压扁，静止时为 { lift: 0, scaleX: 1, scaleY: 1 } */
  const dice = { values: [1, 1], rolling: false, bounce: diceBounce(1) };
  /** 骰子落定的时刻，弹跳结束后为 null */
  let diceLandedAt = null;
  /** 格子特效：tileId → { kind, level, born, ms }，同一格只保留最新一个 */
  const effects = new Map();
  const queue = [];
  let current = null;
  let floaters = [];
  let lastNow = 0;
  let pendingIdle = false;
  /** 播放倍速：动画时长除以该值 */
  let speed = 1;
  /**
   * 最近一次落点：棋子停下的格子和停下的时刻。下一次移动开始时清空。
   * @type {{ index: number, at: number } | null}
   */
  let focus = null;
  /**
   * 当前结果卡：{ data, born, ms, toast }。普通对局时阻塞后续事件；观战模式是不阻塞的提示条。
   * @type {{ data: object, born: number, ms: number, toast: boolean } | null}
   */
  let popup = null;
  /** 观战模式（全是 AI）：光边只淡入淡出一次，不做脉冲，减少闪烁 */
  let calm = false;
  /** 落地次数，每次落地加 1，供外部判断“有新落点” */
  let landings = 0;

  const highlightMs = () => HIGHLIGHT_MS / speed;
  /** 落地停顿不受“减少动态效果”影响：没有移动动画时，仍让“到哪儿”和“发生了什么”分两拍出现 */
  const landPause = () => LAND_PAUSE_MS / speed;

  const duration = (ms) => (reducedMotion ? 0 : ms / speed);

  /** 事件总线监听器，签名与 bus.on 一致 */
  function handle(payload, type) {
    queue.push({ type, payload });
    pendingIdle = true;
    onChange();
  }

  function addEffects(type, p) {
    if (reducedMotion) return;
    for (const [tileId, kind, level] of TILE_EFFECTS[type]?.(p) ?? []) {
      effects.set(tileId, { kind, level, born: lastNow, ms: EFFECT_MS[kind] / speed });
      // 同一格的落点光边交棒给地产特效
      handOff(tileId);
    }
  }

  /** 落点格上开始播放更具体的反馈时，落点光边淡出 */
  function handOff(tileId) {
    if (focus && focus.cutAt === undefined && tileIds[focus.index] === tileId) focus.cutAt = lastNow;
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
    addEffects(type, p);
    // 在落点格付租金或交税：金额出现后光边交棒，顺序是“停在这里 → 付了多少”
    if (type === 'paymentMade' && p.reason?.tileId) handOff(p.reason.tileId);

    // 关键事件弹结果卡。时长不受“减少动态效果”影响（那只是去掉弹出动画），按倍速缩短
    const card = describePopup(type, p);
    if (card) {
      if (calm) {
        popup = { data: card, born: lastNow, ms: TOAST_MS / speed, toast: true };
      } else {
        const ms = POPUP_MS / speed;
        popup = { data: card, born: lastNow, ms, toast: false };
        return { duration: ms, update() {} };
      }
    }

    switch (type) {
      case 'diceRolled':
        diceLandedAt = null;
        dice.bounce = diceBounce(1);
        return {
          duration: duration(DICE_MS),
          onLand(now) {
            if (!reducedMotion) diceLandedAt = now;
          },
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
        focus = null;
        return {
          duration: duration(Math.min(n * STEP_MS, MAX_MOVE_MS)),
          landing: p.to,
          hold: landPause(),
          update(t) {
            const f = t * n;
            const i = Math.min(Math.floor(f), n - 1);
            const u = f - i;
            const e = easeInOut(u);
            tok.gx = lerp(points[i].gx, points[i + 1].gx, e);
            tok.gy = lerp(points[i].gy, points[i + 1].gy, e);
            tok.z = t < 1 ? Math.sin(Math.PI * u) * 0.3 : 0;
          },
        };
      }

      case 'sentToJail': {
        const tok = tokens.get(p.playerId);
        if (!tok) return null;
        const from = { gx: tok.gx, gy: tok.gy };
        const to = gridOf(p.to);
        focus = null;
        return {
          duration: duration(JAIL_MS),
          landing: p.to,
          hold: landPause(),
          update(t) {
            const e = easeInOut(t);
            tok.gx = lerp(from.gx, to.gx, e);
            tok.gy = lerp(from.gy, to.gy, e);
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
      // 落地那一刻就高亮落点，不等停顿结束
      if (!current.landed) {
        current.landed = true;
        if (current.landing !== undefined) {
          focus = { index: current.landing, at: now };
          landings += 1;
        }
        current.onLand?.(now);
      }
      if (now - current.start < current.duration + (current.hold ?? 0)) break;
      current = null;
    }

    floaters = floaters.filter((f) => now - f.born < FLOAT_MS);
    for (const [id, e] of effects) if (now - e.born >= e.ms) effects.delete(id);
    if (popup && now - popup.born >= popup.ms) popup = null;
    const bouncing = diceLandedAt !== null && now - diceLandedAt < DICE_BOUNCE_MS / speed;
    dice.bounce = diceBounce(bouncing ? (now - diceLandedAt) / (DICE_BOUNCE_MS / speed) : 1);
    if (!bouncing) diceLandedAt = null;
    const busy = current !== null || queue.length > 0;
    if (!busy && pendingIdle) {
      pendingIdle = false;
      onIdle();
    }
    const highlighting = focus !== null && now - focus.at < highlightMs() && !(now - (focus.cutAt ?? Infinity) >= GLOW_HANDOFF_MS / speed);
    return busy || floaters.length > 0 || highlighting || bouncing || effects.size > 0 || popup !== null;
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
    /**
     * 最近的落点。index 为格子下标；glow 为高亮强度 0–1，高亮结束后为 0（落点仍保留，用于地产卡片）。
     * 减少动态效果时不做脉冲，高亮期间保持全强度。
     * @returns {{ index: number, glow: number } | null}
     */
    get focus() {
      if (!focus) return null;
      const age = (lastNow - focus.at) / highlightMs();
      // 交棒后线性淡出
      const handoff = focus.cutAt === undefined ? 1 : Math.max(0, 1 - (lastNow - focus.cutAt) / (GLOW_HANDOFF_MS / speed));
      if (age >= 1 || handoff === 0) return { index: focus.index, glow: 0 };
      if (reducedMotion) return { index: focus.index, glow: handoff };
      // 观战：一次淡入淡出；对局：逐渐减弱的脉冲（|cos| 开头为 1，乘以线性衰减）
      const glow = calm ? Math.sin(Math.PI * age) : (0.55 + 0.45 * Math.abs(Math.cos(age * Math.PI * PULSES))) * (1 - age * 0.6);
      return { index: focus.index, glow: glow * handoff };
    },
    /** @param {boolean} value 是否为观战模式（全是 AI） */
    setCalm(value) {
      calm = Boolean(value);
    },
    /**
     * 当前结果卡和进度。
     * @returns {{ data: object, t: number, toast: boolean } | null}
     */
    get popup() {
      if (!popup) return null;
      return { data: popup.data, t: Math.min(1, (lastNow - popup.born) / popup.ms), toast: popup.toast };
    },
    /** 累计落地次数 */
    get landings() {
      return landings;
    },
    /** 当前可见的飘字，rise 为上升高度（格高为单位），alpha 为透明度，scale 为字号倍数（先放大再回落） */
    get floaters() {
      return floaters.map((f) => {
        const age = Math.min(1, (lastNow - f.born) / FLOAT_MS);
        return {
          text: f.text,
          color: f.color,
          gx: f.gx,
          gy: f.gy,
          rise: reducedMotion ? 0 : age * 0.8,
          alpha: 1 - age * age,
          scale: reducedMotion ? 1 : popScale(age),
        };
      });
    },
    /**
     * 进行中的格子特效：tileId → { kind, level, t }，t 为进度 0–1。
     * @returns {Map<string, { kind: string, level?: number, t: number }>}
     */
    get effects() {
      const out = new Map();
      for (const [id, e] of effects) out.set(id, { kind: e.kind, level: e.level, t: Math.min(1, (lastNow - e.born) / e.ms) });
      return out;
    },
  };
}
