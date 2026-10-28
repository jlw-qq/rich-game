import { describe, it, expect, vi } from 'vitest';
import { TILES, GROUPS } from '../../../src/data/config/board.js';
import { RULES } from '../../../src/data/config/rules.js';
import { createBoard } from '../../../src/logic/core/board.js';
import { createEventBus } from '../../../src/logic/core/eventBus.js';
import { createInitialState, validatePlayerSetup, GameSetupError } from '../../../src/logic/core/gameState.js';
import { createTurnMachine, PHASES as P, canTransition } from '../../../src/logic/core/turnMachine.js';

const board = createBoard({ tiles: TILES, groups: GROUPS, rules: RULES });
const names = (n) => Array.from({ length: n }, (_, i) => ({ name: `玩家${i + 1}` }));

function setup(n = 3) {
  const state = createInitialState({ board, rules: RULES, players: names(n), seed: 1 });
  const bus = createEventBus();
  const events = [];
  bus.on('*', (payload, type) => events.push({ type, payload }));
  return { state, bus, events, fsm: createTurnMachine(state, bus) };
}

/** 按正常流程走完一回合 */
function playTurn(fsm) {
  for (const to of [P.MOVING, P.TILE_EVENT, P.SETTLE, P.TURN_END]) {
    expect(fsm.transition(to)).toEqual({ ok: true });
  }
  return fsm.endTurn();
}

describe('createInitialState', () => {
  it('初始化玩家与地产', () => {
    const { state } = setup(4);
    expect(state.players.map((p) => p.id)).toEqual(['p1', 'p2', 'p3', 'p4']);
    expect(state.players.every((p) => p.cash === RULES.startingCash && p.position === 0)).toBe(true);
    expect(Object.keys(state.properties)).toHaveLength(22);
    expect(state.phase).toBe(P.AWAIT_ROLL);
  });

  it('状态可 JSON 往返', () => {
    const { state } = setup();
    expect(JSON.parse(JSON.stringify(state))).toEqual(state);
  });

  it('人数、名字、seed 校验', () => {
    expect(validatePlayerSetup(names(1), RULES).join()).toContain('2–5');
    expect(validatePlayerSetup(names(5), RULES)).toEqual([]);
    expect(validatePlayerSetup(names(6), RULES).join()).toContain('2–5');
    expect(validatePlayerSetup([{ name: 'A' }, { name: '  ' }], RULES).join()).toContain('不能为空');
    expect(validatePlayerSetup([{ name: 'A' }, { name: ' A ' }], RULES).join()).toContain('重复');
    expect(validatePlayerSetup([{ name: 'A' }, { name: 'x'.repeat(13) }], RULES).join()).toContain('超过');
    expect(validatePlayerSetup([{ name: 'A' }, { name: 'B', isAI: 'yes' }], RULES).join()).toContain('isAI');
    expect(validatePlayerSetup('abc', RULES)).toEqual(['玩家列表必须是数组']);
    expect(() => createInitialState({ board, rules: RULES, players: names(2), seed: 1.5 })).toThrow(GameSetupError);
  });
});

describe('阶段跳转', () => {
  it('跳转表', () => {
    expect(canTransition(P.AWAIT_ROLL, P.MOVING)).toBe(true);
    expect(canTransition(P.TILE_EVENT, P.AWAIT_DECISION)).toBe(true);
    expect(canTransition(P.AWAIT_DECISION, P.MOVING)).toBe(false);
    expect(canTransition('nope', P.MOVING)).toBe(false);
  });

  it('非法跳转被拒绝且状态不变', () => {
    const { state, fsm, events } = setup();
    const before = structuredClone(state);
    expect(fsm.transition(P.SETTLE).ok).toBe(false);
    expect(fsm.transition('dance').ok).toBe(false);
    expect(fsm.endTurn().ok).toBe(false);
    expect(state).toEqual(before);
    expect(events).toEqual([]);
  });

  it('等待决策阶段不能再掷骰', () => {
    const { fsm } = setup();
    fsm.transition(P.MOVING);
    fsm.transition(P.TILE_EVENT);
    fsm.transition(P.AWAIT_DECISION);
    expect(fsm.transition(P.MOVING).ok).toBe(false);
    expect(fsm.phase).toBe(P.AWAIT_DECISION);
  });

  it('正常一回合后切到下一位并发事件', () => {
    const { state, fsm, events } = setup();
    expect(playTurn(fsm).ok).toBe(true);
    expect(state.currentPlayerIndex).toBe(1);
    expect(state.turn).toBe(2);
    expect(fsm.phase).toBe(P.AWAIT_ROLL);
    expect(events.at(-1)).toEqual({ type: 'turnStarted', payload: { playerId: 'p2', turn: 2, round: 1 } });
  });

  it('最后一位后回到第一位', () => {
    const { state, fsm } = setup(2);
    playTurn(fsm);
    playTurn(fsm);
    expect(state.currentPlayerIndex).toBe(0);
  });
});

describe('破产与终局', () => {
  it('切换时跳过破产玩家', () => {
    const { state, fsm } = setup(4);
    fsm.declareBankrupt('p2');
    fsm.declareBankrupt('p3');
    playTurn(fsm);
    expect(fsm.currentPlayer().id).toBe('p4');
    playTurn(fsm);
    expect(fsm.currentPlayer().id).toBe('p1');
    expect(state.phase).toBe(P.AWAIT_ROLL);
  });

  it('当前玩家破产直接进入 turnEnd', () => {
    const { fsm } = setup(3);
    fsm.transition(P.MOVING);
    fsm.transition(P.TILE_EVENT);
    expect(fsm.declareBankrupt('p1').ok).toBe(true);
    expect(fsm.phase).toBe(P.TURN_END);
    fsm.endTurn();
    expect(fsm.currentPlayer().id).toBe('p2');
  });

  it('只剩一人时终局，之后所有操作被拒绝', () => {
    const { state, fsm, events } = setup(3);
    fsm.declareBankrupt('p2');
    fsm.declareBankrupt('p1');
    expect(state.phase).toBe(P.GAME_OVER);
    expect(state.winnerId).toBe('p3');
    expect(events.filter((e) => e.type === 'gameOver')).toEqual([
      { type: 'gameOver', payload: { winnerId: 'p3', reason: 'bankruptcy' } },
    ]);
    expect(state.endReason).toBe('bankruptcy');
    expect(fsm.transition(P.MOVING).ok).toBe(false);
    expect(fsm.endTurn().ok).toBe(false);
    expect(fsm.declareBankrupt('p3').ok).toBe(false);
  });

  it('重复破产与不存在的玩家被拒绝', () => {
    const { fsm } = setup(3);
    fsm.declareBankrupt('p2');
    expect(fsm.declareBankrupt('p2').ok).toBe(false);
    expect(fsm.declareBankrupt('p9').ok).toBe(false);
  });

  it('状态异常（全员破产）时 endTurn 不死循环并终局', () => {
    const { state, fsm } = setup(3);
    state.players.forEach((p) => (p.bankrupt = true));
    state.phase = P.TURN_END;
    expect(fsm.endTurn().ok).toBe(true);
    expect(state.phase).toBe(P.GAME_OVER);
    expect(state.winnerId).toBeNull();
  });

  it('currentPlayerIndex 越界时从头找下一位', () => {
    const { state, fsm } = setup(3);
    state.currentPlayerIndex = 99;
    state.phase = P.TURN_END;
    expect(fsm.endTurn().ok).toBe(true);
    expect(state.currentPlayerIndex).toBe(0);
  });
});

describe('eventBus', () => {
  it('取消订阅、回调中取消不影响本次分发', () => {
    const bus = createEventBus();
    const a = vi.fn();
    let offB;
    const b = vi.fn(() => offB());
    bus.on('x', a);
    offB = bus.on('x', b);
    bus.emit('x', 1);
    bus.emit('x', 2);
    expect(a).toHaveBeenCalledTimes(2);
    expect(b).toHaveBeenCalledTimes(1);
  });

  it('监听器抛错不打断其他监听器与逻辑流程', () => {
    const onError = vi.fn();
    const bus = createEventBus({ onError });
    const after = vi.fn();
    bus.on('x', () => {
      throw new Error('boom');
    });
    bus.on('x', after);
    expect(() => bus.emit('x')).not.toThrow();
    expect(after).toHaveBeenCalled();
    expect(onError).toHaveBeenCalledWith(expect.any(Error), 'x');
  });

  it('handler 非函数抛错', () => {
    expect(() => createEventBus().on('x', 1)).toThrow(TypeError);
  });
});
