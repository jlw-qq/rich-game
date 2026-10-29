/**
 * 页面配色的对比度：从 style.css 的 :root 读取颜色变量，检查文字与底色的组合。
 * 正文、次要文字至少 4.5:1；焦点环等非文字元素至少 3:1。
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { contrastRatio } from '../../src/view/render/theme.js';

const css = readFileSync(new URL('../../src/view/ui/style.css', import.meta.url), 'utf8');
const rootBlock = css.slice(css.indexOf(':root {'), css.indexOf('}', css.indexOf(':root {')));
const vars = Object.fromEntries([...rootBlock.matchAll(/--([\w-]+):\s*(#[0-9a-fA-F]{6})\b/g)].map((m) => [m[1], m[2]]));
const v = (name) => {
  expect(vars[name], `缺少颜色变量 --${name}`).toMatch(/^#/);
  return vars[name];
};

describe('页面配色对比度', () => {
  it.each([
    ['正文 on 纸', 'text', 'panel', 4.5],
    ['正文 on 浅纸', 'text', 'panel-2', 4.5],
    ['次要文字 on 纸', 'muted', 'panel', 4.5],
    ['次要文字 on 日志底', 'muted', 'panel-2', 4.5],
    ['高亮日志 on 日志底', 'highlight-text', 'panel-2', 4.5],
    ['错误文字 on 日志底', 'danger-text', 'panel-2', 4.5],
    ['主按钮文字', 'on-accent', 'accent', 4.5],
    ['主按钮悬停', 'on-accent', 'accent-hover', 4.5],
    ['桌面标题 on 木纹深处', 'on-table', 'table-dark', 4.5],
    ['桌面提示 on 木纹深处', 'on-table-muted', 'table-dark', 4.5],
    ['桌面标题 on 木纹亮处', 'on-table', 'table-light', 4.5],
    ['焦点环 on 木纹深处', 'focus', 'table-dark', 3],
    ['焦点环 on 纸', 'focus', 'panel', 3],
  ])('%s ≥ %s', (_, fg, bg, min) => {
    expect(contrastRatio(v(fg), v(bg))).toBeGreaterThanOrEqual(min);
  });
});

describe('棋盘配色对比度', () => {
  it('标题和轮数 on 广场 ≥ 4.5', async () => {
    const { BOARD_COLORS } = await import('../../src/view/render/theme.js');
    expect(contrastRatio(BOARD_COLORS.plazaText, BOARD_COLORS.plaza)).toBeGreaterThanOrEqual(4.5);
  });

  it('格子与卡片上的文字 ≥ 4.5', async () => {
    const { BOARD_COLORS, TILE_COLORS } = await import('../../src/view/render/theme.js');
    for (const [type, bg] of Object.entries(TILE_COLORS)) {
      expect(contrastRatio(BOARD_COLORS.text, bg), type).toBeGreaterThanOrEqual(4.5);
    }
    expect(contrastRatio(BOARD_COLORS.subText, TILE_COLORS.property)).toBeGreaterThanOrEqual(4.5);
  });
});
