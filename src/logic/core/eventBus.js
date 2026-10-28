/**
 * 逻辑层：事件总线。逻辑层只 emit，表现层只 on，表现层不直接改状态。
 * 订阅 '*' 可收到所有事件（用于日志/回放）。
 */

/** 默认把监听器异常抛到微任务里：能在控制台看到，又不会打断逻辑层流程 */
function defaultOnError(err) {
  queueMicrotask(() => {
    throw err;
  });
}

/**
 * @param {{ onError?: (err: unknown, type: string) => void }} [options]
 */
export function createEventBus({ onError = defaultOnError } = {}) {
  /** @type {Map<string, Set<Function>>} */
  const handlers = new Map();

  /**
   * @param {string} type
   * @param {(payload: any, type: string) => void} handler
   * @returns {() => void} 取消订阅
   */
  function on(type, handler) {
    if (typeof handler !== 'function') throw new TypeError('handler 必须是函数');
    if (!handlers.has(type)) handlers.set(type, new Set());
    handlers.get(type).add(handler);
    return () => handlers.get(type)?.delete(handler);
  }

  /**
   * @param {string} type
   * @param {object} [payload]
   */
  function emit(type, payload) {
    // 先拷贝列表，监听器在回调中取消订阅也不影响本次分发
    const list = [...(handlers.get(type) ?? []), ...(handlers.get('*') ?? [])];
    for (const handler of list) {
      try {
        handler(payload, type);
      } catch (err) {
        onError(err, type);
      }
    }
  }

  return { on, emit };
}
