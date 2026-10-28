/**
 * 表现层：创建 DOM 元素的小工具。文字一律作为文本节点插入，玩家名字等用户输入不会被当成 HTML。
 *
 * props 规则：class → className；dataset → data-*；text → textContent；
 * on* → 事件监听；值为 null / undefined / false 的属性跳过；true 写成空字符串属性。
 * @param {string} tag
 * @param {Record<string, any>} [props]
 * @param {...any} children 字符串、数字、Node 或它们的数组；null / false 跳过
 */
export function el(tag, props = {}, ...children) {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(props)) {
    if (value === null || value === undefined || value === false) continue;
    if (key === 'class') node.className = value;
    else if (key === 'dataset') Object.assign(node.dataset, value);
    else if (key === 'text') node.textContent = value;
    else if (key.startsWith('on')) node.addEventListener(key.slice(2), value);
    else node.setAttribute(key, value === true ? '' : String(value));
  }
  for (const child of children.flat(Infinity)) {
    if (child === null || child === undefined || child === false) continue;
    node.append(child instanceof Node ? child : String(child));
  }
  return node;
}
