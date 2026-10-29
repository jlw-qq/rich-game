/**
 * 表现层：事件日志列表。容器应带 aria-live，读屏软件会播报新增条目。
 * 默认收起：只显示最近几条，其余用 hidden 隐藏；展开后显示完整历史并在列表内滚动。
 */

/** 收起时显示的条数 */
export const COLLAPSED_COUNT = 3;

/**
 * 展开/收起按钮的文字。条数不超过收起时的显示数时不需要按钮，返回 null。
 * @param {number} total 当前条数
 * @param {boolean} expanded
 * @returns {string | null}
 */
export function logToggleLabel(total, expanded) {
  if (total <= COLLAPSED_COUNT) return null;
  return expanded ? '收起记录' : `展开全部记录（共 ${total} 条）`;
}

/**
 * @param {HTMLElement} list
 * @param {{
 *   max?: number,
 *   toggle?: HTMLButtonElement | null,
 *   expanded?: boolean,
 *   onToggle?: (expanded: boolean) => void,
 * }} [options] max 为最多保留的条数；toggle 为展开/收起按钮；onToggle 用于记住展开状态
 */
export function createLog(list, { max = 200, toggle = null, expanded = false, onToggle = () => {} } = {}) {
  let isExpanded = expanded;

  /** 按当前状态显示或隐藏各条，更新按钮 */
  function sync() {
    const items = list.children;
    const firstVisible = isExpanded ? 0 : Math.max(0, items.length - COLLAPSED_COUNT);
    for (let i = 0; i < items.length; i++) items[i].hidden = i < firstVisible;
    list.classList.toggle('log-expanded', isExpanded);
    if (!toggle) return;
    const label = logToggleLabel(items.length, isExpanded);
    toggle.hidden = label === null;
    if (label) toggle.textContent = label;
    toggle.setAttribute('aria-expanded', String(isExpanded));
  }

  const scrollToEnd = () => {
    list.scrollTop = list.scrollHeight;
  };

  /**
   * @param {string} text
   * @param {'info' | 'error' | 'highlight'} [kind]
   */
  function add(text, kind = 'info') {
    const li = document.createElement('li');
    li.textContent = text;
    li.className = `log-${kind}`;
    list.append(li);
    while (list.children.length > max) list.firstElementChild.remove();
    sync();
    scrollToEnd();
  }

  function clear() {
    list.replaceChildren();
    sync();
  }

  toggle?.addEventListener('click', () => {
    isExpanded = !isExpanded;
    sync();
    scrollToEnd();
    onToggle(isExpanded);
  });
  sync();

  return { add, clear };
}
