import { TerritoryLayer } from "../../../../src/client/render/canvas/TerritoryLayer";
import { createRenderSettings } from "../../../../src/client/render/gl/RenderSettings";
import { getPaletteSize } from "../../../../src/client/render/gl/utils/ColorUtils";

const PALETTE_SIZE = getPaletteSize();

// 3x3 map. Layout (owner per tile, row-major):
//   row 0 (y=0): 1 1 2   → tiles 0 1 2
//   row 1 (y=1): 1 1 2   → tiles 3 4 5
//   row 2 (y=2): 3 3 3   → tiles 6 7 8
//
// With localPlayerID=1:
//   t=6 (0,2) owner 3 — border (up neighbour t=3 owner 1 differs) and that
//           neighbour IS the local player → HIGHLIGHT border (brightened).
//   t=8 (2,2) owner 3 — border (up neighbour t=5 owner 2 differs) but neither
//           the tile nor its neighbours are owned by local player 1 → NORMAL.
const MAP_W = 3;
const MAP_H = 3;
const TILE_STATE = new Uint16Array([1, 1, 2, 1, 1, 2, 3, 3, 3]);

/** Build a palette whose only meaningful entry is owner 3's border = blue. */
function buildPalette(): Float32Array {
  const p = new Float32Array(PALETTE_SIZE * 2 * 4);
  // Row 1 (border), owner 3 → opaque blue (0, 0, 255, 255).
  const borderBase = (PALETTE_SIZE + 3) * 4;
  p[borderBase] = 0.0;
  p[borderBase + 1] = 0.0;
  p[borderBase + 2] = 1.0;
  p[borderBase + 3] = 1.0;
  return p;
}

/** Read the in-memory borderImageData pixel for tile t (post-flush). */
function borderPixel(
  layer: TerritoryLayer,
  t: number,
): [number, number, number, number] {
  const data = (layer as unknown as { borderImageData: ImageData })
    .borderImageData.data;
  const o = t * 4;
  return [data[o], data[o + 1], data[o + 2], data[o + 3]];
}

describe("TerritoryLayer", () => {
  it("updateRelations / setLocalPlayerID do not throw and trigger a recompute", () => {
    const terrainSource = (): Uint8Array => new Uint8Array(MAP_W * MAP_H);
    const layer = new TerritoryLayer(
      MAP_W,
      MAP_H,
      terrainSource,
      createRenderSettings(),
    );
    const canvas = document.createElement("canvas");
    const ctx = canvas.getContext("2d")!;
    const camera = { x: 0, y: 0, zoom: 1 };

    layer.setPalette(buildPalette());
    layer.uploadFullTileState(TILE_STATE);

    // updateRelations must not throw and must mark borders dirty so the next
    // draw recomputes them.
    expect(() => layer.updateRelations(new Uint8Array(16), 4)).not.toThrow();
    expect(() => layer.setLocalPlayerID(1)).not.toThrow();
    expect(() => layer.draw(ctx, camera)).not.toThrow();

    // t=8 is a border tile (owner 3, up neighbour owner 2 differs); after
    // flush it must carry an opaque pixel.
    const [, , , a] = borderPixel(layer, 8);
    expect(a).toBe(255);

    layer.dispose();
  });

  it("classifies borders touching the local player as highlight (brighter)", () => {
    const terrainSource = (): Uint8Array => new Uint8Array(MAP_W * MAP_H);
    const layer = new TerritoryLayer(
      MAP_W,
      MAP_H,
      terrainSource,
      createRenderSettings(),
    );
    const canvas = document.createElement("canvas");
    const ctx = canvas.getContext("2d")!;
    const camera = { x: 0, y: 0, zoom: 1 };

    layer.setPalette(buildPalette());
    layer.uploadFullTileState(TILE_STATE);

    // Spectator (localPlayerID=0): every border is NORMAL → pure blue.
    layer.setLocalPlayerID(0);
    layer.draw(ctx, camera);
    expect(borderPixel(layer, 6)).toEqual([0, 0, 255, 255]);
    expect(borderPixel(layer, 8)).toEqual([0, 0, 255, 255]);

    // Local player 1: t=6 becomes HIGHLIGHT (R/G brightened toward white),
    // t=8 stays NORMAL (pure blue, untouched).
    layer.setLocalPlayerID(1);
    layer.draw(ctx, camera);
    const highlight = borderPixel(layer, 6);
    const plain = borderPixel(layer, 8);
    expect(plain).toEqual([0, 0, 255, 255]);
    expect(highlight[0]).toBeGreaterThan(120); // R brightened
    expect(highlight[1]).toBeGreaterThan(120); // G brightened
    expect(highlight[2]).toBe(255); // B unchanged
    expect(highlight[3]).toBe(255);

    layer.dispose();
  });
});
