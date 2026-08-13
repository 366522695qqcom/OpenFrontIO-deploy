import { UnitLayer } from "../../../../src/client/render/canvas/UnitLayer";
import { getPaletteSize } from "../../../../src/client/render/gl/utils/ColorUtils";
import type { UnitState } from "../../../../src/client/render/types";
import {
  UT_CITY,
  UT_DEFENSE_POST,
  UT_FACTORY,
  UT_MISSILE_SILO,
  UT_PORT,
  UT_SAM_LAUNCHER,
} from "../../../../src/client/render/types";

const PALETTE_SIZE = getPaletteSize();

/** Build a palette whose only meaningful entry is owner 1's fill = red. */
function buildPalette(): Float32Array {
  const p = new Float32Array(PALETTE_SIZE * 2 * 4);
  // Row 0 (fill), owner 1 → opaque red (1.0, 0.0, 0.0, 1.0).
  p[1 * 4] = 1.0;
  p[1 * 4 + 1] = 0.0;
  p[1 * 4 + 2] = 0.0;
  p[1 * 4 + 3] = 1.0;
  return p;
}

/** Minimal valid UnitState with overridable fields. */
function makeUnit(overrides: Partial<UnitState> = {}): UnitState {
  return {
    id: 1,
    unitType: UT_CITY,
    ownerID: 1,
    lastOwnerID: null,
    pos: 0,
    lastPos: 0,
    isActive: true,
    reachedTarget: false,
    retreating: false,
    targetable: true,
    markedForDeletion: false,
    health: null,
    underConstruction: false,
    targetUnitId: null,
    targetTile: null,
    troops: 0,
    missileTimerQueue: [],
    level: 0,
    veterancy: 0,
    hasTrainStation: false,
    trainType: null,
    loaded: null,
    constructionStartTick: null,
    ...overrides,
  };
}

type PlayerColorFn = (id: number) => [number, number, number];

describe("UnitLayer", () => {
  it("setPalette routes playerColor through the GPU palette (row 0 fill colors)", () => {
    const layer = new UnitLayer(3, 3);
    const color = (id: number) =>
      (layer as unknown as { playerColor: PlayerColorFn }).playerColor(id);

    // Without a palette, playerColor falls back to the HSL hash (not red).
    expect(color(1)).not.toEqual([255, 0, 0]);

    layer.setPalette(buildPalette());
    // Owner 1 is now read from the palette → red.
    expect(color(1)).toEqual([255, 0, 0]);

    // Owner 0 and out-of-range owners still fall back to the HSL hash.
    expect(color(0)).not.toEqual([255, 0, 0]);

    layer.dispose();
  });

  it("setPalette with an empty array reverts to the HSL-hash fallback", () => {
    const layer = new UnitLayer(3, 3);
    const color = (id: number) =>
      (layer as unknown as { playerColor: PlayerColorFn }).playerColor(id);

    layer.setPalette(buildPalette());
    expect(color(1)).toEqual([255, 0, 0]);

    layer.setPalette(new Float32Array(0));
    expect(color(1)).not.toEqual([255, 0, 0]);

    layer.dispose();
  });

  it("draws every structure shape + a mobile unit without throwing", () => {
    const layer = new UnitLayer(3, 3);
    layer.setPalette(buildPalette());

    const units = new Map<number, UnitState>();
    const types = [
      UT_CITY,
      UT_PORT,
      UT_FACTORY,
      UT_DEFENSE_POST,
      UT_SAM_LAUNCHER,
      UT_MISSILE_SILO,
    ];
    types.forEach((unitType, i) => {
      units.set(i + 1, makeUnit({ id: i + 1, unitType, pos: i, level: 2 }));
    });
    // A mobile unit (Warship) + a hot projectile (Shell) — both stay circular.
    units.set(100, makeUnit({ id: 100, unitType: "Warship", pos: 7 }));
    units.set(101, makeUnit({ id: 101, unitType: "Shell", pos: 8 }));
    layer.updateUnits(units, 0);

    const canvas = document.createElement("canvas");
    canvas.width = 300;
    canvas.height = 300;
    const ctx = canvas.getContext("2d")!;
    const camera = { x: 1.5, y: 1.5, zoom: 8 };

    expect(() => layer.draw(ctx, camera)).not.toThrow();

    layer.dispose();
  });
});
