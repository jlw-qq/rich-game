/**
 * 表现层：棋盘缩放与平移（viewport），以及缩放后的坐标反算。
 */
import { describe, it, expect } from 'vitest';
import { createViewport, MAX_SCALE, TAP_ZOOM, ZOOM_MS } from '../../src/view/render/viewport.js';
import { computeLayout, gridOf, project, tileAt } from '../../src/view/render/layout.js';

const W = 358;
const H = 221;

/** 把棋盘坐标变换到屏幕坐标 */
const toScreen = ({ scale, ox, oy }, x, y) => ({ x: x * scale + ox, y: y * scale + oy });

describe('viewport', () => {
  it('初始为全图，toBoard 不变换', () => {
    const v = createViewport(W, H);
    expect(v.view).toEqual({ scale: 1, ox: 0, oy: 0 });
    expect(v.zoomed).toBe(false);
    expect(v.toBoard(10, 20)).toEqual({ x: 10, y: 20 });
  });

  it('点按放大：过渡结束时放大到 TAP_ZOOM，点按位置附近的棋盘移到画面中心', () => {
    const v = createViewport(W, H);
    v.zoomInAt(W / 2, H / 2, 0);
    expect(v.zoomed).toBe(true); // 过渡中也算放大
    expect(v.tick(ZOOM_MS / 2)).toBe(true);
    expect(v.tick(ZOOM_MS)).toBe(false);
    expect(v.view.scale).toBe(TAP_ZOOM);
    // 中心点放大后仍在中心
    const c = v.toBoard(W / 2, H / 2);
    expect(c.x).toBeCloseTo(W / 2);
    expect(c.y).toBeCloseTo(H / 2);
  });

  it('平移有边界：放大后的棋盘始终盖满画布', () => {
    const v = createViewport(W, H);
    v.zoomInAt(W / 2, H / 2, 0);
    v.tick(ZOOM_MS);
    v.pan(10000, 10000);
    expect(v.view.ox).toBe(0);
    expect(v.view.oy).toBe(0);
    v.pan(-100000, -100000);
    expect(v.view.ox).toBeCloseTo(W * (1 - TAP_ZOOM));
    expect(v.view.oy).toBeCloseTo(H * (1 - TAP_ZOOM));
  });

  it('在画布角上点按放大，也不会露出棋盘外的空白', () => {
    const v = createViewport(W, H);
    v.zoomInAt(0, 0, 0);
    v.tick(ZOOM_MS);
    expect(v.view.ox).toBeLessThanOrEqual(0);
    expect(v.view.oy).toBeLessThanOrEqual(0);
  });

  it('捏合缩放限制在 1–3 倍，捏合中心下的棋盘位置不动', () => {
    const v = createViewport(W, H);
    v.pinch(100, 80, 2);
    const before = v.toBoard(100, 80);
    v.pinch(100, 80, 1.2);
    const after = v.toBoard(100, 80);
    expect(after.x).toBeCloseTo(before.x);
    expect(after.y).toBeCloseTo(before.y);
    v.pinch(100, 80, 100);
    expect(v.view.scale).toBe(MAX_SCALE);
    v.pinch(100, 80, 0.001);
    expect(v.view.scale).toBe(1);
    expect(v.view).toEqual({ scale: 1, ox: 0, oy: 0 });
  });

  it('缩小回到全图；尺寸变化时直接回到全图', () => {
    const v = createViewport(W, H);
    v.zoomInAt(50, 50, 0);
    v.tick(ZOOM_MS);
    v.reset(1000);
    v.tick(1000 + ZOOM_MS);
    expect(v.view).toEqual({ scale: 1, ox: 0, oy: 0 });
    expect(v.zoomed).toBe(false);
    v.pinch(10, 10, 2);
    v.resize(800, 500);
    expect(v.view).toEqual({ scale: 1, ox: 0, oy: 0 });
  });

  it('尺寸不变的 resize 不打断放大查看', () => {
    const v = createViewport(W, H);
    v.zoomInAt(100, 100, 0);
    v.tick(ZOOM_MS);
    v.resize(W, H);
    expect(v.view.scale).toBe(TAP_ZOOM);
  });

  it('跟随：放大状态下镜头逐帧靠近目标；全图时不动', () => {
    const v = createViewport(W, H);
    expect(v.follow(0, 0)).toBe(false);
    v.zoomInAt(W / 2, H / 2, 0);
    v.tick(ZOOM_MS);
    const target = { x: 60, y: 60 };
    for (let i = 0; i < 200 && v.follow(target.x, target.y); i++);
    // 目标在边界内时最终居中；在边界外时停在边界
    const s = toScreen(v.view, target.x, target.y);
    expect(Math.abs(s.x - W / 2) < 1 || Math.abs(v.view.ox) < 0.5).toBe(true);
    expect(Math.abs(s.y - H / 2) < 1 || Math.abs(v.view.oy) < 0.5).toBe(true);
  });

  it('放大后，屏幕上每个格子中心经 toBoard 后仍能反算回自己', () => {
    const L = computeLayout(W, H);
    const v = createViewport(W, H);
    v.zoomInAt(W * 0.3, H * 0.7, 0);
    v.tick(ZOOM_MS);
    let visible = 0;
    for (let i = 0; i < 40; i++) {
      const { gx, gy } = gridOf(i);
      const s = toScreen(v.view, ...Object.values(project(L, gx, gy)));
      if (s.x < 0 || s.y < 0 || s.x > W || s.y > H) continue;
      visible += 1;
      const b = v.toBoard(s.x, s.y);
      expect(tileAt(L, b.x, b.y)).toBe(i);
    }
    expect(visible).toBeGreaterThan(3);
  });
});
