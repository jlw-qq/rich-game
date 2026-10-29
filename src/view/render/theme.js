/**
 * 表现层：颜色配置。
 */

export const GROUP_COLORS = {
  brown: '#8b5a2b',
  lightBlue: '#5fb4d9',
  pink: '#d660a8',
  orange: '#f08c2e',
  red: '#e04646',
  yellow: '#e8c430',
  green: '#3aa55d',
  darkBlue: '#2f5fb3',
};

export const PLAYER_COLORS = ['#ff5c5c', '#4fa3ff', '#ffd24f', '#5cd685', '#b07cff'];

export const TILE_COLORS = {
  property: '#f7f3e8',
  start: '#f0e2b6',
  chance: '#ffe7a8',
  fate: '#cfe3ff',
  tax: '#ead0d0',
  jail: '#cfcfcf',
  parking: '#d4ecd4',
  goToJail: '#e6b5b5',
};

/** 棋盘中央与格子装饰 */
export const BOARD_COLORS = {
  center: '#2c5e47',
  /** 统一的格子描边 */
  outline: 'rgba(20, 24, 32, 0.55)',
  shadow: 'rgba(0, 0, 0, 0.45)',
  text: '#222',
  subText: '#555',
};

/** 非地产格的图标颜色，比格子底色深，保证对比度 */
export const ICON_COLORS = {
  start: '#b8860b',
  chance: '#c27c0e',
  fate: '#3a6fc4',
  tax: '#a33b3b',
  jail: '#4a4a4a',
  parking: '#2f7d4a',
  goToJail: '#a33b3b',
};

/**
 * 统一的视觉规则。长度以格高 th 为单位（随棋盘缩放），线宽以 CSS 像素为单位。
 * 卡片、骰子、格子投影、高亮都从这里取值，保证线宽、圆角、阴影一致。
 */
export const STYLE = {
  /** 细描边（格子、卡片、骰子） */
  line: 1,
  /** 强调描边（查看、落点高亮）的最小宽度 */
  emphasisLine: 2,
  /** 圆角：卡片、骰子 */
  radius: 0.16,
  /** 浮起元素（卡片、骰子、标题）的阴影 */
  liftShadow: { color: 'rgba(0, 0, 0, 0.45)', blur: 0.35, offsetY: 0.06 },
};

/** WCAG 规定的小字最低对比度 */
export const MIN_TEXT_CONTRAST = 4.5;
const DARK_TEXT = '#1b1b1b';
const LIGHT_TEXT = '#ffffff';

/** '#rrggbb' → [r, g, b] */
const rgbOf = (hex) => {
  const n = parseInt(hex.slice(1), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
};
const hexOf = (rgb) => `#${rgb.map((v) => Math.round(v).toString(16).padStart(2, '0')).join('')}`;

/** WCAG 相对亮度 */
function luminance(hex) {
  const [r, g, b] = rgbOf(hex).map((v) => {
    const c = v / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

/** 两个颜色的对比度（1–21） */
export function contrastRatio(a, b) {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
}

/**
 * 在给定底色上可读的标题配色：先在白字和深字里选对比度高的；
 * 仍不够 4.5:1 时逐步调深底色，直到白字达标。
 * @param {string} hex '#rrggbb'
 * @returns {{ bg: string, text: string }}
 */
export function readableHeader(hex) {
  const pick = (bg) => (contrastRatio(bg, LIGHT_TEXT) >= contrastRatio(bg, DARK_TEXT) ? LIGHT_TEXT : DARK_TEXT);
  let bg = hex;
  let text = pick(bg);
  for (let f = 0.95; contrastRatio(bg, text) < MIN_TEXT_CONTRAST && f > 0.3; f -= 0.05) {
    bg = hexOf(rgbOf(hex).map((v) => v * f));
    text = LIGHT_TEXT;
  }
  return { bg, text };
}

/** 各组卡片标题栏的配色（预先算好） */
export const GROUP_HEADERS = Object.fromEntries(Object.entries(GROUP_COLORS).map(([g, c]) => [g, readableHeader(c)]));

/**
 * 把十六进制颜色按比例调暗（f < 1）或调亮（f > 1）。
 * @param {string} hex '#rrggbb'
 * @param {number} f
 */
export function shade(hex, f) {
  const n = parseInt(hex.slice(1), 16);
  const ch = (v) => Math.max(0, Math.min(255, Math.round(v * f)));
  return `rgb(${ch((n >> 16) & 255)}, ${ch((n >> 8) & 255)}, ${ch(n & 255)})`;
}
