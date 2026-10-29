/**
 * 表现层：中央城市景观的地块位置、建筑规格和生长进度。
 */
import { describe, it, expect } from 'vitest';
import { TILES, GROUPS } from '../../src/data/config/board.js';
import { RULES } from '../../src/data/config/rules.js';
import { createBoard } from '../../src/logic/core/board.js';
import { buildingSpec, cityGround, cityLots, growth, LANDMARK_KINDS, LANDMARKS, LEVEL_HEIGHTS, PLAZA_MAX, PLAZA_MIN } from '../../src/view/render/city.js';

const board = createBoard({ tiles: TILES, groups: GROUPS, rules: RULES });
const props = TILES.filter((t) => t.type === 'property');

describe('城市地块', () => {
  const lots = cityLots(board);

  it('每块地产一块地，按远近排序', () => {
    expect(lots.map((l) => l.tileId).sort()).toEqual(props.map((t) => t.id).sort());
    for (let i = 1; i < lots.length; i++) expect(lots[i].gx + lots[i].gy).toBeGreaterThanOrEqual(lots[i - 1].gx + lots[i - 1].gy);
  });

  it('地块都在中央区域内、广场外，互不重叠', () => {
    for (const l of lots) {
      for (const v of [l.gx, l.gy]) {
        expect(v).toBeGreaterThan(0.5 + 0.38); // 不压到外圈格子
        expect(v).toBeLessThan(9.5 - 0.38);
      }
      const inPlaza = l.gx > 3.4 - 0.38 && l.gx < 6.6 + 0.38 && l.gy > 3.4 - 0.38 && l.gy < 6.6 + 0.38;
      expect(inPlaza, l.tileId).toBe(false);
    }
    for (let i = 0; i < lots.length; i++) {
      for (let j = i + 1; j < lots.length; j++) {
        const a = lots[i];
        const b = lots[j];
        const apart = Math.max(Math.abs(a.gx - b.gx), Math.abs(a.gy - b.gy));
        expect(apart, `${a.tileId} / ${b.tileId}`).toBeGreaterThanOrEqual(0.76);
      }
    }
  });
});

describe('建筑规格', () => {
  const prop = (ownerId, level, mortgaged = false) => ({ ownerId, level, mortgaged });

  it('无主空地、0 级插旗、1–3 级楼房逐级变高、满级地标', () => {
    expect(buildingSpec(prop(null, 0), 4, 'beijing')).toEqual({ kind: 'empty' });
    expect(buildingSpec(prop('p1', 0), 4, 'beijing')).toEqual({ kind: 'flag' });
    const heights = [1, 2, 3].map((lv) => buildingSpec(prop('p1', lv), 4, 'beijing').height);
    expect(heights).toEqual(LEVEL_HEIGHTS.slice(1));
    expect(heights[0] < heights[1] && heights[1] < heights[2]).toBe(true);
    expect(buildingSpec(prop('p1', 4), 4, 'beijing')).toEqual({ kind: 'landmark', shape: 'gate' });
  });

  it('没有专属地标的城市满级时用摩天楼；所有地标都有对应的造型', () => {
    expect(buildingSpec(prop('p1', 4), 4, 'zhengzhou')).toEqual({ kind: 'landmark', shape: 'skyscraper' });
    for (const [city, shape] of Object.entries(LANDMARKS)) {
      expect(props.some((t) => t.id === city), city).toBe(true);
      expect(LANDMARK_KINDS).toContain(shape);
    }
    expect(new Set(Object.values(LANDMARKS)).size + 1).toBe(LANDMARK_KINDS.length); // 加上摩天楼共 12 种
  });

  it('生长进度：没有特效时为 1；买地、升级时从 0 长到 1；其他特效不影响', () => {
    expect(growth(undefined)).toBe(1);
    expect(growth({ kind: 'buy', t: 0 })).toBeCloseTo(0);
    expect(growth({ kind: 'upgrade', t: 1 })).toBeCloseTo(1);
    expect(growth({ kind: 'mortgage', t: 0.3 })).toBe(1);
  });
});

describe('城市地面', () => {
  const lots = cityLots(board);
  const ground = cityGround(board);
  const HALF = 0.38;
  const lotRect = (l) => ({ gx0: l.gx - HALF, gx1: l.gx + HALF, gy0: l.gy - HALF, gy1: l.gy + HALF });
  const overlaps = (a, b) => a.gx0 < b.gx1 && b.gx0 < a.gx1 && a.gy0 < b.gy1 && b.gy0 < a.gy1;

  it('道路不压到任何地块、公园，也不进入广场', () => {
    const plaza = { gx0: PLAZA_MIN, gx1: PLAZA_MAX, gy0: PLAZA_MIN, gy1: PLAZA_MAX };
    for (const r of ground.roads) {
      for (const l of lots) expect(overlaps(r, lotRect(l)), l.tileId).toBe(false);
      for (const p of ground.parks) expect(overlaps(r, lotRect(p))).toBe(false);
      expect(overlaps(r, plaza)).toBe(false);
    }
  });

  it('公园放在没有地产的位置，不和地块重叠；每块地都落在人行道上', () => {
    expect(ground.parks.length).toBeGreaterThan(0);
    for (const p of ground.parks) for (const l of lots) expect(overlaps(lotRect(p), lotRect(l))).toBe(false);
    const inside = (r, l) => l.gx - HALF >= r.gx0 && l.gx + HALF <= r.gx1 && l.gy - HALF >= r.gy0 && l.gy + HALF <= r.gy1;
    for (const l of lots) expect(ground.sidewalks.some((r) => inside(r, l)), l.tileId).toBe(true);
  });

  it('所有地面都在中央区域内，不压到外圈格子', () => {
    for (const r of [...ground.sidewalks, ...ground.roads]) {
      expect(Math.min(r.gx0, r.gy0)).toBeGreaterThanOrEqual(0.5);
      expect(Math.max(r.gx1, r.gy1)).toBeLessThanOrEqual(9.5);
    }
  });
});
