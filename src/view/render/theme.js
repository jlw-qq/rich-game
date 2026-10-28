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
