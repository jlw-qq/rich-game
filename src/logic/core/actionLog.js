/**
 * 逻辑层：本机对局里人类玩家的操作记录（state.actionLog），用来让服务器重放对局、核实排行榜成绩。
 *
 * 只记成功执行的操作。AI 的操作不记：重放时 AI 由同一个 AI 执行器按同样的状态重新决定，
 * 结果完全一样（骰子、卡牌、AI 各有存在 state 里的随机数状态）。
 * actionLog 为 null 表示这局不能重放（旧存档迁移来的，或记录超出上限）。
 */
import { ACTION_KINDS } from './actions.js';

/** 一局最多记多少步；正常短局约 100–300 步，超出后停止记录、这局不能上榜 */
export const MAX_LOGGED_ACTIONS = 2000;

const isPlainObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const isInt = (v, min, max) => Number.isInteger(v) && v >= min && v <= max;
const isId = (v) => typeof v === 'string' && v.length > 0 && v.length <= 40;

/** 交易的一边：只留认识的字段，数量有上限。更细的检查（是不是自己的地等）交给 systems/trade.js */
function cleanSide(v) {
  if (v === undefined || v === null) return { properties: [], cash: 0, jailCards: 0 };
  if (!isPlainObject(v)) return null;
  const { properties = [], cash = 0, jailCards = 0 } = v;
  if (!Array.isArray(properties) || properties.length > 40 || !properties.every(isId)) return null;
  if (!isInt(cash, 0, 1e9) || !isInt(jailCards, 0, 16)) return null;
  return { properties: [...properties], cash, jailCards };
}

/**
 * 把一个操作整理成只含已知字段的纯数据；格式不对返回 null。
 * 存进记录、以及服务器读入别人提交的记录，都先经过这里。
 * @param {unknown} v
 * @returns {{ kind: string, tileId?: string, index?: number, amount?: number, trade?: object } | null}
 */
export function cleanLoggedAction(v) {
  if (!isPlainObject(v) || !ACTION_KINDS.includes(v.kind)) return null;
  const action = { kind: v.kind };
  if (v.tileId !== undefined) {
    if (!isId(v.tileId)) return null;
    action.tileId = v.tileId;
  }
  if (v.index !== undefined) {
    if (!isInt(v.index, 0, 15)) return null;
    action.index = v.index;
  }
  if (v.amount !== undefined) {
    if (!isInt(v.amount, 0, 1e9)) return null;
    action.amount = v.amount;
  }
  if (v.trade !== undefined) {
    if (!isPlainObject(v.trade) || !isId(v.trade.toId)) return null;
    const give = cleanSide(v.trade.give);
    const take = cleanSide(v.trade.take);
    if (!give || !take) return null;
    action.trade = { toId: v.trade.toId, give, take };
  }
  return action;
}

/**
 * 记下一个已成功执行的人类操作。记录已经作废（null）或超出上限时不再记。
 * @param {{ actionLog: object[] | null }} state
 * @param {object} action
 */
export function recordAction(state, action) {
  if (!Array.isArray(state.actionLog)) return;
  const clean = cleanLoggedAction(action);
  if (!clean || state.actionLog.length >= MAX_LOGGED_ACTIONS) {
    state.actionLog = null;
    return;
  }
  state.actionLog.push(clean);
}

/**
 * 读档时检查记录的格式（内容是否和对局吻合要靠重放才知道）。
 * @returns {string[]}
 */
export function actionLogErrors(log) {
  if (log === null) return [];
  if (!Array.isArray(log)) return ['actionLog 必须是数组或 null'];
  if (log.length > MAX_LOGGED_ACTIONS) return [`actionLog 超过 ${MAX_LOGGED_ACTIONS} 步`];
  const bad = log.findIndex((a) => cleanLoggedAction(a) === null);
  return bad >= 0 ? [`actionLog[${bad}] 格式无效`] : [];
}
