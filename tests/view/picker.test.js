/**
 * 表现层：屏幕坐标反算格子（tileAt）和查看状态（createSelection）。
 */
import { describe, it, expect } from 'vitest';
import { computeLayout, gridOf, project, tileAt, TILE_SCALE } from '../../src/view/render/layout.js';
import { createSelection } from '../../src/view/ui/boardPicker.js';

describe('tileAt', () => {
  it.each([
    [960, 600],
    [400, 250],
    [1600, 700],
  ])('%i×%i：每个格子中心和顶面内的点都能反算回自己', (w, h) => {
    const L = computeLayout(w, h);
    for (let i = 0; i < 40; i++) {
      const { gx, gy } = gridOf(i);
      const c = project(L, gx, gy);
      expect(tileAt(L, c.x, c.y)).toBe(i);
      // 顶面菱形内靠近四个角的点
      const d = TILE_SCALE / 2 - 0.05;
      for (const [u, v] of [[d, 0], [-d, 0], [0, d], [0, -d]]) {
        const p = project(L, gx + u, gy + v);
        expect(tileAt(L, p.x, p.y)).toBe(i);
      }
    }
  });

  it('格子之间的缝隙、中央区域、画布外返回 null', () => {
    const L = computeLayout(960, 600);
    // 第 1 格和第 2 格之间的缝隙（网格 x 方向相隔 1，中点是缝）
    const a = gridOf(1);
    const b = gridOf(2);
    const gap = project(L, (a.gx + b.gx) / 2, a.gy);
    expect(tileAt(L, gap.x, gap.y)).toBeNull();
    const center = project(L, 5, 5);
    expect(tileAt(L, center.x, center.y)).toBeNull();
    expect(tileAt(L, -10, -10)).toBeNull();
    expect(tileAt(L, 5000, 5000)).toBeNull();
  });
});

describe('查看状态', () => {
  it('优先级：悬停 > 固定选中 > 最近落点', () => {
    const s = createSelection(40);
    expect(s.current(null)).toBeNull();
    expect(s.current(7)).toEqual({ index: 7, source: 'landing' });
    s.click(3);
    expect(s.current(7)).toEqual({ index: 3, source: 'pinned' });
    s.setHover(5);
    expect(s.current(7)).toEqual({ index: 5, source: 'hover' });
    s.setHover(null);
    expect(s.current(7)).toEqual({ index: 3, source: 'pinned' });
  });

  it('点同一格、点空白处、clear 都能取消固定；点其他格改为固定该格', () => {
    const s = createSelection(40);
    s.click(3);
    s.click(3);
    expect(s.pinned).toBeNull();
    s.click(3);
    s.click(null);
    expect(s.pinned).toBeNull();
    s.click(3);
    s.click(9);
    expect(s.pinned).toBe(9);
    s.clear();
    expect(s.pinned).toBeNull();
  });

  it('方向键从当前查看的格子开始，在 39 和 0 之间首尾相接', () => {
    const s = createSelection(40);
    expect(s.step(1, 38)).toBe(39); // 没有查看中的格子时从落点开始
    expect(s.step(1)).toBe(0);
    expect(s.step(-1)).toBe(39);
    s.clear();
    s.setHover(10);
    expect(s.step(1)).toBe(11); // 悬停中按方向键，从悬停的格子继续
  });
});
