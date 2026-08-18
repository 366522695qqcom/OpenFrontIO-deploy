/**
 * TerritoryLayer — CPU (Canvas2D) renderer for terrain + territory fill + borders.
 *
 * Owns three offscreen mapW × mapH canvases:
 *   - terrainCanvas:  baked once (and on terrain delta / ocean-color change).
 *   - territoryCanvas: one fill pixel per tile, blitted under territoryAlpha.
 *   - borderCanvas:    1px border pixels where a tile's owner differs from a
 *                      4-neighbour, drawn at full alpha on top of the fill.
 *
 * Territory + border pixels are recomputed lazily in {@link flush} from a local
 * {@link tileMirror} (Uint16Array), driven by a dirty set / dirty-all flag so
 * multiple per-frame deltas coalesce. The world→screen projection in
 * {@link draw} mirrors the GPU {@link Camera} (see Camera.ts worldToScreen) so
 * territory aligns with terrain/units rendered by the other layers.
 */

import type { RenderSettings } from "../gl/RenderSettings";
import {
  buildTerrainRGBA,
  encodeTerrainTile,
  getPaletteSize,
  hexToRgb,
  type TerrainColorOverrides,
} from "../gl/utils/ColorUtils";
import { FALLOUT_BIT, OWNER_MASK } from "../gl/utils/TileCodec";
import type { PlayerStatic } from "../types";

/** Palette row stride (fill row 0, border row 1). */
const PALETTE_SIZE = getPaletteSize();

export interface CanvasCamera {
  x: number;
  y: number;
  zoom: number;
}

/** Mutable bounding box of dirty tiles (in tile coords). */
interface DirtyBBox {
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
}

/** Static fallout tint mixed into owned fill at ~50% (dark green). */
const FALLOUT_TINT: readonly [number, number, number] = [40, 80, 30];

export class TerritoryLayer {
  private readonly mapW: number;
  private readonly mapH: number;
  private readonly terrainSource: () => Uint8Array;
  private readonly settings: RenderSettings;

  private terrainCanvas: HTMLCanvasElement;
  private terrainCtx: CanvasRenderingContext2D;
  private terrainRGBA: Uint8Array;
  private terrainImageData: ImageData;

  private territoryCanvas: HTMLCanvasElement;
  private territoryCtx: CanvasRenderingContext2D;
  private territoryImageData: ImageData;

  private borderCanvas: HTMLCanvasElement;
  private borderCtx: CanvasRenderingContext2D;
  private borderImageData: ImageData;

  private tileMirror: Uint16Array;
  private paletteData: Float32Array | null = null;
  private readonly dirtyTiles = new Set<number>();
  private dirtyAll = false;

  /** Active same-owner defense posts (tile coords + owner). */
  private defensePosts: { x: number; y: number; ownerID: number }[] = [];
  /** Per-tile defense coverage flag (1 = tile is defended by a same-owner post). */
  private defenseCoverage: Uint8Array;

  // Relationship matrix (size×size, indexed [ownerA, ownerB]) — values are
  // 0=neutral, 1=friendly, 2=embargo (see Affiliation.ts / BorderComputePass).
  // Stored for API parity with the GPU path; the CPU fallback's 3-state border
  // classification is driven by `localPlayerID` (see `writeBorderPixel`).
  private relationsData: Uint8Array | null = null;
  private relationsSize = 0;
  private localPlayerID = 0;

  constructor(
    mapW: number,
    mapH: number,
    terrainSource: () => Uint8Array,
    settings: RenderSettings,
  ) {
    this.mapW = mapW;
    this.mapH = mapH;
    this.terrainSource = terrainSource;
    this.settings = settings;
    this.tileMirror = new Uint16Array(mapW * mapH);
    this.defenseCoverage = new Uint8Array(mapW * mapH);

    const terrain = this.createOffscreen(mapW, mapH);
    this.terrainCanvas = terrain.canvas;
    this.terrainCtx = terrain.ctx;
    this.terrainRGBA = new Uint8Array(mapW * mapH * 4);
    this.terrainImageData = this.terrainCtx.createImageData(mapW, mapH);
    this.bakeTerrain();

    const territory = this.createOffscreen(mapW, mapH);
    this.territoryCanvas = territory.canvas;
    this.territoryCtx = territory.ctx;
    this.territoryImageData = this.territoryCtx.createImageData(mapW, mapH);

    const border = this.createOffscreen(mapW, mapH);
    this.borderCanvas = border.canvas;
    this.borderCtx = border.ctx;
    this.borderImageData = this.borderCtx.createImageData(mapW, mapH);
  }

  // ---------------------------------------------------------------------------
  // Offscreen canvas helper
  // ---------------------------------------------------------------------------

  private createOffscreen(
    w: number,
    h: number,
  ): { canvas: HTMLCanvasElement; ctx: CanvasRenderingContext2D } {
    const canvas = document.createElement("canvas");
    canvas.width = w;
    canvas.height = h;
    const ctx = canvas.getContext("2d");
    if (ctx === null) {
      throw new Error("Canvas2D context unavailable for TerritoryLayer");
    }
    ctx.imageSmoothingEnabled = false;
    return { canvas, ctx };
  }

  // ---------------------------------------------------------------------------
  // Terrain
  // ---------------------------------------------------------------------------

  private colorsFromSettings(): TerrainColorOverrides {
    const t = this.settings.terrain;
    return {
      oceanColor: hexToRgb(t.oceanColor) ?? undefined,
      sandColor: hexToRgb(t.sandColor) ?? undefined,
      plainsColor: hexToRgb(t.plainsColor) ?? undefined,
      highlandColor: hexToRgb(t.highlandColor) ?? undefined,
      mountainColor: hexToRgb(t.mountainColor) ?? undefined,
    };
  }

  /** Bake the full terrain RGBA into terrainCanvas (constructor + rebuild). */
  private bakeTerrain(): void {
    const rgba = buildTerrainRGBA(
      this.terrainSource(),
      this.mapW,
      this.mapH,
      this.colorsFromSettings(),
    );
    this.terrainRGBA.set(rgba);
    this.terrainImageData.data.set(this.terrainRGBA);
    this.terrainCtx.putImageData(this.terrainImageData, 0, 0);
  }

  // ---------------------------------------------------------------------------
  // Public data upload
  // ---------------------------------------------------------------------------

  setPalette(paletteData: Float32Array): void {
    this.paletteData = paletteData;
    this.markAllDirty();
  }

  /**
   * Store the relationship matrix. Border classification depends on relation
   * state (the GPU path uses it for self/ally/neutral/embargo coloring), so a
   * change invalidates all borders. The CPU fallback currently classifies
   * highlight borders via `localPlayerID`; the matrix is stored for parity and
   * future use.
   */
  updateRelations(data: Uint8Array, size: number): void {
    this.relationsData = data;
    this.relationsSize = size;
    this.markAllDirty();
  }

  /** Store the local player's smallID; borders touching their territory are
   *  reclassified as highlight borders on the next flush. */
  setLocalPlayerID(id: number): void {
    this.localPlayerID = id;
    this.markAllDirty();
  }

  addPlayers(
    _players: PlayerStatic[],
    paletteData: Float32Array,
    _patternMeta: Float32Array,
    _patternData: Uint8Array,
  ): void {
    // Patterns/skins are GPU-only; CPU territory uses solid palette colors.
    this.paletteData = paletteData;
    this.markAllDirty();
  }

  /** Delta path: copy changed tiles + mark dirty (defer recompute to draw). */
  updateTileState(
    tileState: Uint16Array,
    changedTiles: readonly number[],
  ): void {
    const mirror = this.tileMirror;
    const n = mirror.length;
    const dirty = this.dirtyTiles;
    for (const t of changedTiles) {
      if (t < 0 || t >= n) continue;
      mirror[t] = tileState[t];
      if (!this.dirtyAll) dirty.add(t);
    }
  }

  /** Full path: replace the whole mirror + invalidate everything. */
  uploadFullTileState(tileState: Uint16Array): void {
    this.tileMirror.set(tileState);
    this.markAllDirty();
  }

  /**
   * Replace the set of defense posts and recompute per-tile coverage (same
   * owner + within `defensePostRange`, matching the GPU DefenseCoveragePass
   * circle stamp). A post appearing/disappearing can flip its whole circle, so
   * the full map is recomputed and re-flushed.
   */
  updateDefensePosts(posts: { x: number; y: number; ownerID: number }[]): void {
    this.defensePosts = posts;
    this.recomputeCoverageAll();
    this.markAllDirty();
  }

  /** Re-bake only the affected terrain texels (e.g. water nukes). */
  applyTerrainDelta(refs: readonly number[], terrainBytes: Uint8Array): void {
    const colors = this.colorsFromSettings();
    const data = this.terrainImageData.data;
    const n = this.mapW * this.mapH;
    for (const ref of refs) {
      if (ref < 0 || ref >= n) continue;
      encodeTerrainTile(terrainBytes[ref], this.terrainRGBA, ref * 4, colors);
      data.set(this.terrainRGBA.subarray(ref * 4, ref * 4 + 4), ref * 4);
      const tx = ref % this.mapW;
      const ty = (ref / this.mapW) | 0;
      this.terrainCtx.putImageData(this.terrainImageData, 0, 0, tx, ty, 1, 1);
    }
  }

  /** Re-bake terrain from the source (e.g. ocean-color setting changed). */
  rebuildTerrain(): void {
    this.bakeTerrain();
  }

  // ---------------------------------------------------------------------------
  // Dirty recompute (territory fill + borders)
  // ---------------------------------------------------------------------------

  private markAllDirty(): void {
    this.dirtyAll = true;
    this.dirtyTiles.clear();
  }

  /**
   * True when tile `t` is a territory border (its owner differs from any
   * 4-neighbour). Border tiles are skipped by the defense fill darken (they
   * get the checkerboard overlay in writeBorderPixel instead) — matching the
   * GPU territory.frag.glsl `uBorderTex` test.
   */
  private isBorderTile(t: number): boolean {
    const mirror = this.tileMirror;
    const owner = mirror[t] & OWNER_MASK;
    if (owner === 0) return false;
    const mapW = this.mapW;
    const mapH = this.mapH;
    const tx = t % mapW;
    const ty = (t / mapW) | 0;
    if (tx > 0 && (mirror[t - 1] & OWNER_MASK) !== owner) return true;
    if (tx < mapW - 1 && (mirror[t + 1] & OWNER_MASK) !== owner) return true;
    if (ty > 0 && (mirror[t - mapW] & OWNER_MASK) !== owner) return true;
    if (ty < mapH - 1 && (mirror[t + mapW] & OWNER_MASK) !== owner) return true;
    return false;
  }

  /**
   * Recompute the defense-coverage flag for one tile: covered iff a same-owner
   * defense post is within `defensePostRange` (squared distance), mirroring the
   * GPU DefenseCoveragePass circle stamp. Coverage depends only on this tile's
   * own owner, so a single tile's recompute is always sufficient.
   */
  private recomputeCoverageForTile(t: number): void {
    const mirror = this.tileMirror;
    const owner = mirror[t] & OWNER_MASK;
    let covered = false;
    if (owner !== 0) {
      const mapW = this.mapW;
      const tx = t % mapW;
      const ty = (t / mapW) | 0;
      const range = this.settings.mapOverlay.defensePostRange;
      const rangeSq = range * range;
      for (const post of this.defensePosts) {
        if (post.ownerID !== owner) continue;
        const dx = tx - post.x;
        const dy = ty - post.y;
        if (dx * dx + dy * dy <= rangeSq) {
          covered = true;
          break;
        }
      }
    }
    this.defenseCoverage[t] = covered ? 1 : 0;
  }

  /** Recompute defense coverage for the whole map (posts changed). */
  private recomputeCoverageAll(): void {
    const n = this.mapW * this.mapH;
    for (let t = 0; t < n; t++) this.recomputeCoverageForTile(t);
  }

  /** Write the fill pixel for one tile into territoryImageData. */
  private writeFillPixel(t: number): void {
    const palette = this.paletteData;
    const owner = this.tileMirror[t] & OWNER_MASK;
    const o4 = t * 4;
    const data = this.territoryImageData.data;
    if (owner === 0 || palette === null) {
      data[o4] = 0;
      data[o4 + 1] = 0;
      data[o4 + 2] = 0;
      data[o4 + 3] = 0;
      return;
    }
    let r = Math.round(palette[owner * 4] * 255);
    let g = Math.round(palette[owner * 4 + 1] * 255);
    let b = Math.round(palette[owner * 4 + 2] * 255);
    const a = Math.round(palette[owner * 4 + 3] * 255);
    const sat = this.settings.mapOverlay.territorySaturation;
    if (sat < 1) {
      const gray = 0.299 * r + 0.587 * g + 0.114 * b;
      r = gray + (r - gray) * sat;
      g = gray + (g - gray) * sat;
      b = gray + (b - gray) * sat;
    }
    if ((this.tileMirror[t] & FALLOUT_BIT) !== 0) {
      r = r * 0.5 + FALLOUT_TINT[0] * 0.5;
      g = g * 0.5 + FALLOUT_TINT[1] * 0.5;
      b = b * 0.5 + FALLOUT_TINT[2] * 0.5;
    }
    // Defense bonus: darken the fill on interior tiles defended by a same-owner
    // post. Border tiles are skipped — they get the checkerboard overlay from
    // writeBorderPixel instead (matches territory.frag.glsl uBorderTex test).
    if (this.defenseCoverage[t] === 1 && !this.isBorderTile(t)) {
      const darken = this.settings.mapOverlay.territoryDefenseDarken;
      r = r * darken;
      g = g * darken;
      b = b * darken;
    }
    data[o4] = r;
    data[o4 + 1] = g;
    data[o4 + 2] = b;
    data[o4 + 3] = a;
  }

  /**
   * Write the border pixel for one tile into borderImageData.
   *
   * 3-state classification (matches the GPU BorderComputePass borderType
   * channel: 0=interior, 0.5=normal border, 1.0=highlight border):
   *   - interior:        owner is 0 or all 4 neighbours share the owner.
   *   - normal border:   a neighbour differs in owner; the border does not
   *                      touch the local player's territory.
   *   - highlight border: a neighbour differs in owner AND the tile or one of
   *                      its cardinal neighbours is owned by `localPlayerID`.
   *                      Rendered by mixing the palette border color 50% with
   *                      white (the GPU path thickens via Chebyshev expansion;
   *                      ImageData is single-pixel so we brighten instead).
   *
   * When `localPlayerID === 0` (spectator) this degrades to the original
   * binary classification — every border is normal.
   */
  private writeBorderPixel(t: number): void {
    const palette = this.paletteData;
    const owner = this.tileMirror[t] & OWNER_MASK;
    const o4 = t * 4;
    const data = this.borderImageData.data;
    if (owner === 0 || palette === null) {
      data[o4] = 0;
      data[o4 + 1] = 0;
      data[o4 + 2] = 0;
      data[o4 + 3] = 0;
      return;
    }
    const mapW = this.mapW;
    const mapH = this.mapH;
    const tx = t % mapW;
    const ty = (t / mapW) | 0;
    const mirror = this.tileMirror;
    const lp = this.localPlayerID;
    let isBorder = false;
    let touchesLocal = lp !== 0 && owner === lp;
    if (tx > 0) {
      const no = mirror[t - 1] & OWNER_MASK;
      if (no !== owner) isBorder = true;
      if (lp !== 0 && no === lp) touchesLocal = true;
    }
    if (tx < mapW - 1) {
      const no = mirror[t + 1] & OWNER_MASK;
      if (no !== owner) isBorder = true;
      if (lp !== 0 && no === lp) touchesLocal = true;
    }
    if (ty > 0) {
      const no = mirror[t - mapW] & OWNER_MASK;
      if (no !== owner) isBorder = true;
      if (lp !== 0 && no === lp) touchesLocal = true;
    }
    if (ty < mapH - 1) {
      const no = mirror[t + mapW] & OWNER_MASK;
      if (no !== owner) isBorder = true;
      if (lp !== 0 && no === lp) touchesLocal = true;
    }
    if (isBorder) {
      const base = (PALETTE_SIZE + owner) * 4;
      let r = Math.round(palette[base] * 255);
      let g = Math.round(palette[base + 1] * 255);
      let b = Math.round(palette[base + 2] * 255);
      const a = Math.round(palette[base + 3] * 255);
      if (touchesLocal) {
        // Highlight border: mix 50% with white for a brighter pixel.
        r = r * 0.5 + 255 * 0.5;
        g = g * 0.5 + 255 * 0.5;
        b = b * 0.5 + 255 * 0.5;
      }
      // Defense bonus: checkerboard darken on defended border tiles (applied
      // AFTER the relation/highlight tint, matching border-stamp.frag.glsl).
      if (this.defenseCoverage[t] === 1 && ((tx + ty) & 1) === 1) {
        const darken = this.settings.mapOverlay.defenseCheckerDarken;
        r = r * darken;
        g = g * darken;
        b = b * darken;
      }
      data[o4] = r;
      data[o4 + 1] = g;
      data[o4 + 2] = b;
      data[o4 + 3] = a;
    } else {
      data[o4] = 0;
      data[o4 + 1] = 0;
      data[o4 + 2] = 0;
      data[o4 + 3] = 0;
    }
  }

  /** Recompute dirty territory/border pixels and blit dirty regions. */
  private flush(): void {
    if (!this.dirtyAll && this.dirtyTiles.size === 0) return;
    const mapW = this.mapW;
    const mapH = this.mapH;
    const n = mapW * mapH;
    const fb: DirtyBBox = { minX: mapW, minY: mapH, maxX: -1, maxY: -1 };
    const bb: DirtyBBox = { minX: mapW, minY: mapH, maxX: -1, maxY: -1 };
    const expand = (b: DirtyBBox, t: number): void => {
      const tx = t % mapW;
      const ty = (t / mapW) | 0;
      if (tx < b.minX) b.minX = tx;
      if (ty < b.minY) b.minY = ty;
      if (tx > b.maxX) b.maxX = tx;
      if (ty > b.maxY) b.maxY = ty;
    };

    if (this.dirtyAll) {
      for (let t = 0; t < n; t++) {
        this.writeFillPixel(t);
        this.writeBorderPixel(t);
      }
      fb.minX = 0;
      fb.minY = 0;
      fb.maxX = mapW - 1;
      fb.maxY = mapH - 1;
      bb.minX = 0;
      bb.minY = 0;
      bb.maxX = mapW - 1;
      bb.maxY = mapH - 1;
    } else {
      const dirty = this.dirtyTiles;
      for (const t of dirty) {
        // A tile changing owner can flip its own defense-coverage flag
        // (same-owner test), so re-derive it before writing the pixels.
        // Coverage is per-tile (independent of neighbours), so one recompute
        // per changed tile is sufficient — this mirrors the GPU path's
        // per-tile markTileDirty semantics for the common combat-delta case.
        this.recomputeCoverageForTile(t);
        this.writeFillPixel(t);
        expand(fb, t);
        // Border status of t and its 4-neighbours can change when t's owner
        // changes, so recompute all five.
        this.writeBorderPixel(t);
        expand(bb, t);
        const tx = t % mapW;
        const ty = (t / mapW) | 0;
        if (tx > 0) {
          this.writeBorderPixel(t - 1);
          expand(bb, t - 1);
        }
        if (tx < mapW - 1) {
          this.writeBorderPixel(t + 1);
          expand(bb, t + 1);
        }
        if (ty > 0) {
          this.writeBorderPixel(t - mapW);
          expand(bb, t - mapW);
        }
        if (ty < mapH - 1) {
          this.writeBorderPixel(t + mapW);
          expand(bb, t + mapW);
        }
      }
    }

    if (fb.maxX >= 0) {
      this.territoryCtx.putImageData(
        this.territoryImageData,
        0,
        0,
        fb.minX,
        fb.minY,
        fb.maxX - fb.minX + 1,
        fb.maxY - fb.minY + 1,
      );
    }
    if (bb.maxX >= 0) {
      this.borderCtx.putImageData(
        this.borderImageData,
        0,
        0,
        bb.minX,
        bb.minY,
        bb.maxX - bb.minX + 1,
        bb.maxY - bb.minY + 1,
      );
    }

    this.dirtyAll = false;
    this.dirtyTiles.clear();
  }

  // ---------------------------------------------------------------------------
  // Render
  // ---------------------------------------------------------------------------

  draw(ctx: CanvasRenderingContext2D, camera: CanvasCamera): void {
    this.flush();
    const canvasW = ctx.canvas.width;
    const canvasH = ctx.canvas.height;
    const zoom = camera.zoom;
    // World → device-px transform mirroring Camera.worldToScreen:
    //   deviceX = zoom * (worldX - camera.x) + canvasW / 2
    //   deviceY = zoom * (worldY - camera.y) + canvasH / 2
    // (camera.zoom already carries the DPR factor; the backing store is in
    // device px, so no extra DPR scaling is needed here.)
    ctx.save();
    ctx.imageSmoothingEnabled = false;
    ctx.setTransform(
      zoom,
      0,
      0,
      zoom,
      canvasW / 2 - zoom * camera.x,
      canvasH / 2 - zoom * camera.y,
    );
    ctx.drawImage(this.terrainCanvas, 0, 0);
    ctx.globalAlpha = this.settings.mapOverlay.territoryAlpha;
    ctx.drawImage(this.territoryCanvas, 0, 0);
    ctx.globalAlpha = 1;
    ctx.drawImage(this.borderCanvas, 0, 0);
    ctx.restore();
  }

  dispose(): void {
    this.terrainCanvas.width = 0;
    this.terrainCanvas.height = 0;
    this.territoryCanvas.width = 0;
    this.territoryCanvas.height = 0;
    this.borderCanvas.width = 0;
    this.borderCanvas.height = 0;
    this.terrainRGBA = new Uint8Array(0);
    this.tileMirror = new Uint16Array(0);
    this.dirtyTiles.clear();
    this.dirtyAll = false;
    this.paletteData = null;
    this.relationsData = null;
    this.relationsSize = 0;
    this.localPlayerID = 0;
    this.defensePosts = [];
    this.defenseCoverage = new Uint8Array(0);
  }
}
