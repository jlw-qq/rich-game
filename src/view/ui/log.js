/**
 * 表现层：事件日志列表。容器应带 aria-live，读屏软件会播报新增条目。
 * @param {HTMLElement} list
 * @param {{ max?: number }} [options] 最多保留的条数
 */
export function createLog(list, { max = 200 } = {}) {
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
    list.scrollTop = list.scrollHeight;
  }

  function clear() {
    list.replaceChildren();
  }

  return { add, clear };
}
