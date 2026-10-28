/**
 * 逻辑层：存档与读档。数据层负责格式和校验和，这里再校验对局内容是否合法。
 */
import { parseSave, serializeSave } from '../../data/save/saveFormat.js';
import { PHASES } from './turnMachine.js';
import { validateState } from './stateValidator.js';

/**
 * 只能在“稳定”阶段存档：等待玩家操作的阶段。
 * moving / tileEvent / settle 是同步流程的中间态，正常情况下外部看不到。
 */
export const SAVABLE_PHASES = [
  PHASES.AWAIT_ROLL,
  PHASES.AWAIT_DECISION,
  PHASES.AWAIT_PAYMENT,
  PHASES.TURN_END,
  PHASES.GAME_OVER,
];

/**
 * @param {object} state
 * @returns {{ ok: true, text: string } | { ok: false, error: string }}
 */
export function exportSave(state) {
  if (!SAVABLE_PHASES.includes(state.phase)) return { ok: false, error: `当前阶段不能存档: ${state.phase}` };
  return { ok: true, text: serializeSave(state) };
}

/**
 * 解析存档文本并校验对局内容。返回的 state 是新对象，可以直接交给 createGame。
 * @param {unknown} text
 * @param {{ board: object, rules: object, cards: object[] }} ctx
 * @returns {{ ok: true, state: object, savedAt: number | null } | { ok: false, error: string, details?: string[] }}
 */
export function importSave(text, ctx) {
  const parsed = parseSave(text);
  if (!parsed.ok) return parsed;
  return checkLoadedState(parsed, ctx);
}

/**
 * 对已通过格式检查的存档再做内容校验（供 createSaveStore().load() 的结果复用）。
 * @param {{ ok: true, state: object, savedAt: number | null }} parsed
 * @param {{ board: object, rules: object, cards: object[] }} ctx
 */
export function checkLoadedState(parsed, ctx) {
  const errors = validateState(parsed.state, ctx);
  if (!SAVABLE_PHASES.includes(parsed.state?.phase)) errors.push(`存档停在中间阶段: ${parsed.state?.phase}`);
  if (errors.length > 0) return { ok: false, error: '存档内容无效', details: errors };
  return { ok: true, state: structuredClone(parsed.state), savedAt: parsed.savedAt };
}
