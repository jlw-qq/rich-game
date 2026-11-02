/**
 * 表现层：开局页的主视觉。用真实的棋盘渲染器和动画器画起点附近的一角微缩城市：
 * 一栋楼长高冒星，一枚棋子走过去停在别人的地上付租金，金币飞向地主，然后从头再来。
 * 只用一份演示用的状态，不碰存档和对局。减少动态效果时只画一张静止画面。
 */
import { createBoardRenderer } from './boardRenderer.js';
import { createAnimator } from './animator.js';
import { computeLayout, gridOf, project } from './layout.js';
import { createInitialState } from '../../logic/core/gameState.js';
import { calcRent } from '../../logic/systems/property.js';

/** 一轮演示播完后停多久再从头开始（毫秒） */
export const HERO_PAUSE_MS = 1400;
/** 画面高宽比 */
const ASPECT = 0.42;
/** 镜头对准起点和城市中心之间、偏起点的位置 */
const FOCUS = { index: 0, towardCenter: 0.32 };

/**
 * 演示的初始摆放：几块地有楼、上海是地标，1 号棋子站在北京前 3 格。
 * @returns {{ state: object, events: [string, object][], after: () => void }}
 *   events 为一轮要播放的事件；after 把状态改成事件播完后的样子（动画器建好之后再调用）
 */
export function heroScript(board, rules) {
  const state = createInitialState({
    board,
    rules,
    players: ['小红', '小蓝', '小黄', '小绿'].map((name) => ({ name })),
    seed: 1,
  });
  for (const prop of Object.values(state.properties)) prop.ownerId = null;
  const own = (id, ownerId, level) => Object.assign(state.properties[id], { ownerId, level });
  own('shanghai', 'p2', rules.maxLevel);
  own('beijing', 'p2', 2);
  own('xining', 'p3', 1);
  own('yinchuan', 'p3', 2);
  own('hangzhou', 'p4', 1);
  [36, 2, 5, 38].forEach((pos, i) => (state.players[i].position = pos));

  // 下面的事件播放时，状态要已经是“之后”的样子：西宁升到 2 级，小红走到北京
  const after = () => {
    state.properties.xining.level = 2;
    state.players[0].position = 39;
  };
  const events = [
    ['propertyUpgraded', { playerId: 'p3', tileId: 'xining', level: 2, cost: 500 }],
    ['playerMoved', { playerId: 'p1', from: 36, to: 39, steps: 3, path: [37, 38, 39] }],
    ['paymentMade', { payerId: 'p1', payeeIds: ['p2'], amount: calcRent({ state, board, rules }, 'beijing'), reason: { type: 'rent', tileId: 'beijing' } }],
  ];
  return { state, events, after };
}

/**
 * @param {{ board: object, rules: object, reducedMotion?: boolean }} options
 * @returns {{ element: HTMLCanvasElement, start: () => void, stop: () => void }}
 */
export function createHero({ board, rules, reducedMotion = false }) {
  const canvas = document.createElement('canvas');
  canvas.className = 'setup-hero-art';
  canvas.setAttribute('role', 'img');
  canvas.setAttribute('aria-label', '微缩城市棋盘：棋子在街区间走动，地产上的楼房一层层长高');
  const renderer = createBoardRenderer(canvas);
  const tileIds = board.tiles.map((t) => t.id);

  let raf = 0;
  let size = { w: 0, h: 0 };
  let scene = null;
  /** 一轮播完的时刻；null 表示还在播 */
  let doneAt = null;

  function newScene(now) {
    const { state, events, after } = heroScript(board, rules);
    // 动画器按播放前的位置放棋子，之后再把状态改成播完的样子
    const animator = createAnimator({ state, tileIds, reducedMotion });
    if (!reducedMotion) {
      after();
      for (const [type, payload] of events) animator.handle(payload, type);
      animator.tick(now);
    }
    scene = { state, animator };
    doneAt = null;
  }

  function fit() {
    const w = Math.round(canvas.clientWidth);
    const h = Math.round(w * ASPECT);
    if (w === 0 || (w === size.w && h === size.h)) return w > 0;
    size = { w, h };
    canvas.style.height = `${h}px`;
    renderer.resize(w, h);
    return true;
  }

  function draw() {
    const { w, h } = size;
    const layout = computeLayout(w, h);
    const g = gridOf(FOCUS.index);
    const k = FOCUS.towardCenter;
    const pt = project(layout, g.gx + (5 - g.gx) * k, g.gy + (5 - g.gy) * k);
    // 窄屏上放大少一些，免得只剩一两格
    const scale = w < 420 ? 1.8 : 2.2;
    const view = { scale, ox: w / 2 - pt.x * scale, oy: h * 0.55 - pt.y * scale };
    const a = scene.animator;
    renderer.draw({
      board,
      state: scene.state,
      tokens: a.tokens,
      dice: a.dice,
      floaters: a.floaters,
      effects: a.effects,
      poses: a.poses,
      coins: a.coins,
      maxLevel: rules.maxLevel,
      reducedMotion,
      view,
    });
  }

  function frame(now) {
    raf = 0;
    if (!canvas.isConnected || !fit()) return;
    if (!scene) newScene(now);
    const moving = scene.animator.tick(now);
    draw();
    if (reducedMotion) return;
    if (!moving && doneAt === null) doneAt = now;
    if (doneAt !== null && now - doneAt >= HERO_PAUSE_MS) newScene(now);
    raf = requestAnimationFrame(frame);
  }

  const onResize = () => {
    if (!raf) raf = requestAnimationFrame(frame);
  };

  return {
    element: canvas,
    /** 开局页显示时调用；重复调用无副作用 */
    start() {
      window.addEventListener('resize', onResize);
      if (!raf) raf = requestAnimationFrame(frame);
    },
    /** 开局页隐藏时调用，停止出帧 */
    stop() {
      window.removeEventListener('resize', onResize);
      if (raf) cancelAnimationFrame(raf);
      raf = 0;
      scene = null;
    },
  };
}
