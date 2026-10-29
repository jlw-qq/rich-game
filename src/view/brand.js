/**
 * 表现层：游戏名称与标志。标志是一座等距积木小楼加一枚“城”字印章，
 * 网页（SVG）和画布（Path2D）共用同一份路径数据，保证各处一模一样。
 * 坐标系为 64×64。
 */

export const GAME_NAME = '城市大富翁';

/** 积木小楼的三个面和窗格，按从后到前的顺序 */
const SHAPES = [
  { d: 'M32 6 L54 18 L32 30 L10 18 Z', fill: '#f2c14e' }, // 顶面
  { d: 'M10 18 L32 30 L32 54 L10 42 Z', fill: '#e6863b' }, // 左面
  { d: 'M32 30 L54 18 L54 42 L32 54 Z', fill: '#b5432f' }, // 右面
  { d: 'M15 26 L20 28.8 L20 34 L15 31.2 Z M23 30.4 L28 33.2 L28 38.4 L23 35.6 Z M15 35 L20 37.8 L20 43 L15 40.2 Z M23 39.4 L28 42.2 L28 47.4 L23 44.6 Z', fill: '#fbf6ea' },
];
const OUTLINE = '#2b1d10';
/** 印章：右下角的红色方印，旋转一点更像盖上去的 */
const SEAL = { x: 38, y: 36, size: 24, angle: -8, fill: '#c0392b', text: '城' };

/**
 * 标志的 SVG 文本，可用于 innerHTML 或 data URI。
 * @param {number} size 像素尺寸
 * @param {string} [title] 无障碍名称；不传时整个标志对读屏隐藏
 */
export function logoSvg(size, title) {
  const a11y = title ? `role="img" aria-label="${title}"` : 'aria-hidden="true" focusable="false"';
  const paths = SHAPES.map((s) => `<path d="${s.d}" fill="${s.fill}" stroke="${OUTLINE}" stroke-width="1.6" stroke-linejoin="round"/>`).join('');
  const { x, y, size: k, angle, fill, text } = SEAL;
  const seal =
    `<g transform="rotate(${angle} ${x + k / 2} ${y + k / 2})">` +
    `<rect x="${x}" y="${y}" width="${k}" height="${k}" rx="3" fill="${fill}" stroke="#fbf6ea" stroke-width="2"/>` +
    `<text x="${x + k / 2}" y="${y + k / 2 + 1}" text-anchor="middle" dominant-baseline="middle" font-size="17" font-weight="700" ` +
    `font-family="'STKaiti','KaiTi','Microsoft YaHei',serif" fill="#fbf6ea">${text}</text></g>`;
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64" width="${size}" height="${size}" ${a11y}>${paths}${seal}</svg>`;
}

/** 浏览器标签页的小图标 */
export function faviconHref() {
  return `data:image/svg+xml,${encodeURIComponent(logoSvg(64))}`;
}

/**
 * 在画布上画标志。(cx, cy) 为中心，size 为边长（像素）。
 * @param {CanvasRenderingContext2D} ctx
 */
export function drawLogo(ctx, cx, cy, size) {
  const k = size / 64;
  ctx.save();
  ctx.translate(cx - size / 2, cy - size / 2);
  ctx.scale(k, k);
  ctx.lineJoin = 'round';
  ctx.lineWidth = 1.6;
  ctx.strokeStyle = OUTLINE;
  for (const s of SHAPES) {
    const p = new Path2D(s.d);
    ctx.fillStyle = s.fill;
    ctx.fill(p);
    ctx.stroke(p);
  }
  const { x, y, size: w, angle, fill, text } = SEAL;
  ctx.translate(x + w / 2, y + w / 2);
  ctx.rotate((angle * Math.PI) / 180);
  ctx.beginPath();
  ctx.roundRect(-w / 2, -w / 2, w, w, 3);
  ctx.fillStyle = fill;
  ctx.fill();
  ctx.lineWidth = 2;
  ctx.strokeStyle = '#fbf6ea';
  ctx.stroke();
  ctx.fillStyle = '#fbf6ea';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.font = `700 17px 'STKaiti', 'KaiTi', 'Microsoft YaHei', serif`;
  ctx.fillText(text, 0, 1);
  ctx.restore();
}
