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

/** Read the in-memory territoryImageData pixel for tile t (post-flush). */
function territoryPixel(
  layer: TerritoryLayer,
  t: number,
): [number, number, number, number] {
  const data = (layer as unknown as { territoryImageData: ImageData })
    .territoryImageData.data;
  const o = t * 4;
  return [data[o], data[o + 1], data[o + 2], data[o + 3]];
}

/**
 * Palette for the defense tests. Owner 1's fill is a mid-gray (0.5,0.5,0.5,1)
 * so the default territorySaturation (0.85) leaves it untouched (gray == its
 * own grayscale), making the ×territoryDefenseDarken result exact: 128 × 0.55
 * ≈ 70. Owner 1's border row is opaque blue for the checkerboard assertions.
 */
function buildDefensePalette(): Float32Array {
  const p = new Float32Array(PALETTE_SIZE * 2 * 4);
  const fillBase = 1 * 4;
  p[fillBase] = 0.5;
  p[fillBase + 1] = 0.5;
  p[fillBase + 2] = 0.5;
  p[fillBase + 3] = 1.0;
  const borderBase = (PALETTE_SIZE + 1) * 4;
  p[borderBase] = 0.0;
  p[borderBase + 1] = 0.0;
  p[borderBase + 2] = 1.0;
  p[borderBase + 3] = 1.0;
  return p;
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

  it("defense coverage darkens interior fill", () => {
    const W = 10;
    const H = 10;
    const terrainSource = (): Uint8Array => new Uint8Array(W * H);
    // Uniform owner-1 map → every tile is an interior tile (no borders).
    const tileState = new Uint16Array(W * H).fill(1);
    const layer = new TerritoryLayer(
      W,
      H,
      terrainSource,
      createRenderSettings(),
    );
    layer.setPalette(buildDefensePalette());
    layer.uploadFullTileState(tileState);

    const canvas = document.createElement("canvas");
    const ctx = canvas.getContext("2d")!;
    const camera = { x: 0, y: 0, zoom: 1 };

    // A same-owner Defense Post at (5,5) covers the whole 10x10 map with the
    // default range (30); tile (6,5) is interior + covered → fill darkened.
    layer.updateDefensePosts([{ x: 5, y: 5, ownerID: 1 }]);
    layer.draw(ctx, camera);
    expect(territoryPixel(layer, 5 * W + 6)).toEqual([70, 70, 70, 255]);

    layer.dispose();
  });

  it("defense coverage darkens border checkerboard", () => {
    const W = 10;
    const H = 10;
    const terrainSource = (): Uint8Array => new Uint8Array(W * H);
    const tileState = new Uint16Array(W * H).fill(1);
    // Row y=5 owned by player 2 → every tile in row y=4 borders a different
    // owner. A post at (5,4) covers both probe tiles (default range 30).
    for (let x = 0; x < W; x++) tileState[5 * W + x] = 2;
    const layer = new TerritoryLayer(
      W,
      H,
      terrainSource,
      createRenderSettings(),
    );
    layer.setPalette(buildDefensePalette());
    layer.uploadFullTileState(tileState);
    layer.setLocalPlayerID(0);
    layer.updateDefensePosts([{ x: 5, y: 4, ownerID: 1 }]);

    const canvas = document.createElement("canvas");
    const ctx = canvas.getContext("2d")!;
    const camera = { x: 0, y: 0, zoom: 1 };
    layer.draw(ctx, camera);

    // (6,3): interior + covered → fill still darkened even next to a border.
    expect(territoryPixel(layer, 3 * W + 6)).toEqual([70, 70, 70, 255]);
    // (6,4): border, (6+4)&1 === 0 → NOT checker-darkened → pure blue.
    expect(borderPixel(layer, 4 * W + 6)).toEqual([0, 0, 255, 255]);
    // (7,4): border, (7+4)&1 === 1 → checker-darkened ×0.4 → blue ×0.4 = 102.
    expect(borderPixel(layer, 4 * W + 7)).toEqual([0, 0, 102, 255]);

    layer.dispose();
  });

  it("non-covered tiles unchanged", () => {
    const W = 10;
    const H = 10;
    const terrainSource = (): Uint8Array => new Uint8Array(W * H);
    const tileState = new Uint16Array(W * H).fill(1);
    // A single owner-2 tile at (9,6) makes (9,5) a border tile far from the post.
    tileState[6 * W + 9] = 2;
    const settings = createRenderSettings();
    // Shrink the range so (8,5)/(9,5) fall outside the covered circle.
    settings.mapOverlay.defensePostRange = 2;
    const layer = new TerritoryLayer(W, H, terrainSource, settings);
    layer.setPalette(buildDefensePalette());
    layer.uploadFullTileState(tileState);
    layer.setLocalPlayerID(0);
    layer.updateDefensePosts([{ x: 5, y: 5, ownerID: 1 }]);

    const canvas = document.createElement("canvas");
    const ctx = canvas.getContext("2d")!;
    const camera = { x: 0, y: 0, zoom: 1 };
    layer.draw(ctx, camera);

    // (8,5): interior but outside range (dx=3 > 2) → fill untouched (128).
    expect(territoryPixel(layer, 5 * W + 8)).toEqual([128, 128, 128, 255]);
    // (9,5): border (down neighbour (9,6) is owner 2) but outside range → the
    // border pixel is not checker-darkened → pure blue.
    expect(borderPixel(layer, 5 * W + 9)).toEqual([0, 0, 255, 255]);

    layer.dispose();
  });

  it("updating defense posts triggers a full redraw", () => {
    const W = 10;
    const H = 10;
    const terrainSource = (): Uint8Array => new Uint8Array(W * H);
    const tileState = new Uint16Array(W * H).fill(1);
    const layer = new TerritoryLayer(
      W,
      H,
      terrainSource,
      createRenderSettings(),
    );
    layer.setPalette(buildDefensePalette());
    layer.uploadFullTileState(tileState);

    const canvas = document.createElement("canvas");
    const ctx = canvas.getContext("2d")!;
    const camera = { x: 0, y: 0, zoom: 1 };

    // No posts yet → tile (6,5) fill is the plain gray 128.
    layer.draw(ctx, camera);
    expect(territoryPixel(layer, 5 * W + 6)).toEqual([128, 128, 128, 255]);

    // Adding a post recomputes coverage and marks the whole map dirty; the
    // next draw re-flushes with the darkened fill.
    layer.updateDefensePosts([{ x: 5, y: 5, ownerID: 1 }]);
    layer.draw(ctx, camera);
    expect(territoryPixel(layer, 5 * W + 6)).toEqual([70, 70, 70, 255]);

    layer.dispose();
  });
});
