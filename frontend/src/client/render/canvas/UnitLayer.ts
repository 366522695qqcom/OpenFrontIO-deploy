// UnitLayer — Canvas2D (CPU) fallback for units, structures, names, and HUD.
//
// Renders a playable subset of the GPU unit/structure/name passes: mobile
// units, structures, player names, selection rings, attack rings, nuke
// telegraphs, nuke trajectory, spawn overlay, ghost preview, and the move
// indicator. Non-essential FX (spiral ribbons, railroad dust, bonus popups,
// conquest FX, dead-unit sprites, player skins, map-layer PNGs) are no-ops —
// graceful degradation so the game stays playable without WebGL.

import { assetUrl } from "../../../core/AssetUrls";
import type { MapLayer } from "../../../core/game/TerrainMapLoader";
import type { SpiralRibbon } from "../frame/SpiralTrails";
import type { SpawnCenter } from "../gl/passes/SpawnOverlayPass";
import type { AttackTroopLabel } from "../gl/passes/WorldTextPass";
import type { RenderSettings } from "../gl/RenderSettings";
import { getPaletteSize } from "../gl/utils/ColorUtils";
import { OWNER_MASK } from "../gl/utils/TileCodec";
import type {
  AttackRingInput,
  BonusEvent,
  ConquestFx,
  DeadUnitFx,
  GhostPreviewData,
  NameEntry,
  NukeTelegraphData,
  NukeTrajectoryData,
  PlayerState,
  PlayerStatusData,
  UnitState,
} from "../types";
import {
  NUKE_TYPES,
  STRUCTURE_TYPES,
  UT_CITY,
  UT_DEFENSE_POST,
  UT_FACTORY,
  UT_MIRV_WARHEAD,
  UT_MISSILE_SILO,
  UT_PORT,
  UT_SAM_LAUNCHER,
  UT_SAM_MISSILE,
  UT_SHELL,
} from "../types";
import type { CanvasCamera } from "./TerritoryLayer";

// --- Tunables ---------------------------------------------------------------
// These mirror render-settings.json. RenderSettings isn't routed to UnitLayer
// (only mapW/mapH are passed via the constructor), so the defaults are inlined
// here to keep the file self-contained.
const UNIT_SIZE = 13; // world tiles — mobile unit sprite size
const ICON_SIZE = 60; // screen-px structure icon base size
const DOTS_ZOOM_THRESHOLD = 1.2;
const DOT_SCALE = 0.3;
const ICON_SCALE_FACTOR_ZOOMED_OUT = 3;
const ICON_GROW_ZOOM = 7;
const NAME_SCALE_FACTOR = 0.4;
const ATTACK_RING_SCREEN_PX = 30;
const SPAWN_SELF_RADIUS = 30;
const SPAWN_MATE_RADIUS = 14;

/**
 * Fallback railroad tunables used when no RenderSettings is routed in (only
 * legacy 2-arg constructions, e.g. tests, hit this). Mirrors the `railroad`
 * block of render-settings.json; only the railroad section is ever read here.
 */
const RAIL_FALLBACK_SETTINGS = {
  railroad: {
    railMinZoom: 3,
    railFadeRange: 2,
    railDetailZoom: 6,
    railAlpha: 1,
    railThickness: 1,
  },
} as RenderSettings;

/** One railroad-construction dust particle (world coords + ms lifetime). */
interface RailDustParticle {
  x: number;
  y: number;
  vx: number;
  vy: number;
  born: number;
  lifeMs: number;
  radius: number;
}

const SHAPE_SCALES: Record<string, number> = {
  City: 1,
  Port: 1.08,
  Factory: 1.08,
  "Defense Post": 1,
  "SAM Launcher": 1.4,
  "Missile Silo": 1.55,
};

/**
 * Structure icon atlas (same icon-atlas.png the GPU StructurePass samples).
 * Column order must match StructurePass.STRUCTURE_ORDER:
 *   0=City, 1=Port, 2=Factory, 3=DefensePost, 4=SAMLauncher, 5=MissileSilo
 */
const STRUCTURE_ATLAS_URL = assetUrl("atlases/icon-atlas.png");
const STRUCTURE_ATLAS_COL: Record<string, number> = {
  [UT_CITY]: 0,
  [UT_PORT]: 1,
  [UT_FACTORY]: 2,
  [UT_DEFENSE_POST]: 3,
  [UT_SAM_LAUNCHER]: 4,
  [UT_MISSILE_SILO]: 5,
};
const ATLAS_CELL = 64; // atlas cell size in px (6 columns × 64px)

/** Player palette row stride — owners 0..PALETTE_SIZE-1 are addressable. */
const PALETTE_SIZE = getPaletteSize();

// Missile/projectile types — rendered as bright dots (no sprite atlas on CPU).
const HOT_TYPES: ReadonlySet<string> = new Set([
  ...NUKE_TYPES,
  UT_MIRV_WARHEAD,
]);
const PROJ_TYPES: ReadonlySet<string> = new Set([UT_SHELL, UT_SAM_MISSILE]);

type RGB = [number, number, number];

/** hsl(hue 0-360, s 0-1, l 0-1) → 0-255 RGB tuple. */
function hslToRgb(h: number, s: number, l: number): RGB {
  const c = (1 - Math.abs(2 * l - 1)) * s;
  const hp = h / 60;
  const x = c * (1 - Math.abs((hp % 2) - 1));
  let r = 0;
  let g = 0;
  let b = 0;
  if (hp < 1) {
    r = c;
    g = x;
  } else if (hp < 2) {
    r = x;
    g = c;
  } else if (hp < 3) {
    g = c;
    b = x;
  } else if (hp < 4) {
    g = x;
    b = c;
  } else if (hp < 5) {
    r = x;
    b = c;
  } else {
    r = c;
    b = x;
  }
  const m = l - c / 2;
  return [
    Math.round((r + m) * 255),
    Math.round((g + m) * 255),
    Math.round((b + m) * 255),
  ];
}

function rgbCss([r, g, b]: RGB): string {
  return `rgb(${r},${g},${b})`;
}

function rgbaCss([r, g, b]: RGB, a: number): string {
  return `rgba(${r},${g},${b},${a})`;
}

/** Cubic Bezier evaluation at t in [0,1]. */
function cubicBez(
  p0: number,
  p1: number,
  p2: number,
  p3: number,
  t: number,
): number {
  const u = 1 - t;
  return (
    u * u * u * p0 + 3 * u * u * t * p1 + 3 * u * t * t * p2 + t * t * t * p3
  );
}

export class UnitLayer {
  private mapW: number;
  private mapH: number;
  private settings: RenderSettings;

  private units = new Map<number, UnitState>();
  private structures = new Map<number, UnitState>();
  /** Structure icon atlas image (loaded async; null until ready). */
  private structureAtlas: HTMLImageElement | null = null;
  private names = new Map<string, NameEntry>();
  private displayNames = new Map<string, string>();
  private players = new Map<number, PlayerState>();
  private selectedUnitIds: number[] = [];
  private localPlayerID = 0;
  private highlightOwner = 0;
  private altView = false;

  // GPU player palette (Float32 RGBA, row 0 = fill colors). When set, colors
  // are read from here so CPU-rendered units/structures match the GPU path.
  private paletteData: Float32Array | null = null;

  /** Full-map tile code mirror (Uint16Array) for rail owner lookup. */
  private tileState: Uint16Array | null = null;
  /**
   * Caller-owned railroad state (Uint8Array, value per tile: 0 = none,
   * 1-6 = rail type). The array is mutated in place each tick by the caller,
   * so this layer keeps the reference (no copy).
   */
  private railroadState: Uint8Array | null = null;
  private railroadDirty = false;
  /** Local player's rail color override (RGB 0-255); null = use palette. */
  private localRailColor: RGB | null = null;
  private railDust: RailDustParticle[] = [];
  private lastDustTime = 0;

  private attackRings: AttackRingInput[] = [];
  private nukeTelegraphs: NukeTelegraphData[] = [];
  private nukeTrajectory: NukeTrajectoryData | null = null;
  private ghostPreview: GhostPreviewData | null = null;
  private moveIndicator: {
    tileX: number;
    tileY: number;
    ownerID: number;
  } | null = null;
  private spawnActive = false;
  private spawnCenters: SpawnCenter[] = [];

  private colorCache = new Map<number, RGB>();

  constructor(
    mapW: number = 0,
    mapH: number = 0,
    settings: RenderSettings = RAIL_FALLBACK_SETTINGS,
  ) {
    this.mapW = mapW;
    this.mapH = mapH;
    this.settings = settings;
    this.loadStructureAtlas();
  }

  /**
   * Load the structure icon atlas used by the GPU path so the CPU fallback
   * renders the same seedream colored building icons. Failure is silent —
   * drawing falls back to the plain geometric silhouettes.
   */
  private loadStructureAtlas(): void {
    const img = new Image();
    img.crossOrigin = "anonymous";
    img.onload = () => {
      this.structureAtlas = img;
    };
    img.src = STRUCTURE_ATLAS_URL;
  }

  // ---------------------------------------------------------------------------
  // Data upload
  // ---------------------------------------------------------------------------

  updateUnits(units: Map<number, UnitState>, _gameTick: number): void {
    this.units = units;
  }

  updateStructures(units: Map<number, UnitState>): void {
    const filtered = new Map<number, UnitState>();
    for (const u of units.values()) {
      if (u.isActive && STRUCTURE_TYPES.has(u.unitType)) {
        filtered.set(u.id, u);
      }
    }
    this.structures = filtered;
  }

  updateNames(
    names: Map<string, NameEntry>,
    players: Map<number, PlayerState>,
    _snap: boolean,
    _statusData?: Map<number, PlayerStatusData>,
  ): void {
    this.names = names;
    this.players = players;
  }

  refreshNames(displayNames: Map<string, string>): void {
    this.displayNames = displayNames;
  }

  setSelectedUnits(unitIds: readonly number[]): void {
    this.selectedUnitIds = unitIds.slice();
  }

  // ---------------------------------------------------------------------------
  // HUD indicator inputs
  // ---------------------------------------------------------------------------

  updateGhostPreview(data: GhostPreviewData | null): void {
    this.ghostPreview = data;
  }

  updateNukeTrajectory(data: NukeTrajectoryData | null): void {
    this.nukeTrajectory = data;
  }

  updateNukeTelegraphs(data: NukeTelegraphData[]): void {
    this.nukeTelegraphs = data;
  }

  updateSpawnOverlay(inSpawnPhase: boolean, centers: SpawnCenter[]): void {
    this.spawnActive = inSpawnPhase;
    this.spawnCenters = centers;
  }

  showMoveIndicator(tileX: number, tileY: number, ownerID: number): void {
    this.moveIndicator = { tileX, tileY, ownerID };
  }

  updateAttackRings(rings: AttackRingInput[]): void {
    this.attackRings = rings;
  }

  // FX inputs not rendered on the CPU path (graceful degradation).
  setAttackTroopLabels(_labels: AttackTroopLabel[]): void {}
  applyDeadUnits(_deadUnits: DeadUnitFx[]): void {}
  applyConquestEvents(_events: ConquestFx[]): void {}
  applyBonusEvents(_events: BonusEvent[]): void {}
  updateSpiralRibbons(_ribbons: readonly SpiralRibbon[]): void {}
  applyRailroadDust(tileRefs: number[]): void {
    const now = performance.now();
    for (const ref of tileRefs) {
      if (Math.random() > 0.33) continue;
      const x = ref % this.mapW;
      const y = (ref - x) / this.mapW;
      const count = 3 + Math.floor(Math.random() * 3); // 3-5 particles
      for (let i = 0; i < count; i++) {
        this.railDust.push({
          x: x + 0.5 + (Math.random() - 0.5) * 0.4,
          y: y + 0.5 + (Math.random() - 0.5) * 0.4,
          vx: (Math.random() - 0.5) * 0.4,
          vy: (Math.random() - 0.5) * 0.4,
          born: now,
          lifeMs: 400 + Math.random() * 300,
          radius: 0.08 + Math.random() * 0.08,
        });
      }
    }
  }
  updateSmallPlayerGlow(_set: Uint8Array | null): void {}
  setSAMAllianceClusters(_clusters: Map<number, number>): void {}

  // Map-layer PNGs are skipped: their placement masking needs terrain bytes
  // and they belong between terrain and territory (below units), not above.
  setMapLayers(_layers: MapLayer[], _images: Map<string, ImageBitmap>): void {}
  setLayerVisible(_layerId: string, _visible: boolean): void {}
  markLayerTilesDestroyed(_layerId: string, _tileIndices: number[]): void {}
  setLayerDestroyedMask(_layerId: string, _mask: Uint8Array): void {}

  // Player skins aren't supported on the CPU path.
  setPlayerSkin(_smallID: number, _url: string): void {}
  initSkinAtlas(_urls: readonly string[]): void {}
  setPlayerSpawn(_smallID: number, _x: number, _y: number): void {}

  /**
   * Store the full-map tile state (owner lookup for rail colors). The array is
   * caller-owned; the same instance is re-uploaded on every delta/full update.
   */
  setTileState(tileState: Uint16Array): void {
    this.tileState = tileState;
  }

  /**
   * Adopt the caller-owned railroad state (mutated in place each tick). Rails
   * are re-read from the reference on every draw, so no copy is needed.
   */
  uploadRailroadState(data: Uint8Array): void {
    this.railroadState = data;
    this.railroadDirty = true;
  }

  // ---------------------------------------------------------------------------
  // Render-affecting setters
  // ---------------------------------------------------------------------------

  setLocalPlayerID(id: number): void {
    this.localPlayerID = id;
  }

  /**
   * Adopt the GPU player palette (Float32 RGBA, row 0 = fill colors). Clears
   * the color cache so subsequent {@link playerColor} calls re-read from the
   * new palette. Pass null/empty to revert to the HSL-hash fallback.
   */
  setPalette(paletteData: Float32Array): void {
    this.paletteData = paletteData.length > 0 ? paletteData : null;
    this.colorCache.clear();
  }

  /**
   * Override the rail color for the local player's rails (RGB 0-1 floats,
   * matching the GPU path's setLocalRailColor). Stored as 0-255 RGB.
   */
  setLocalRailColor(r: number, g: number, b: number): void {
    this.localRailColor = [
      Math.round(r * 255),
      Math.round(g * 255),
      Math.round(b * 255),
    ];
  }

  setAltView(active: boolean): void {
    this.altView = active;
  }

  setGridView(_active: boolean): void {}

  setShowPatterns(_active: boolean): void {}

  setHighlightOwner(ownerID: number): void {
    this.highlightOwner = ownerID;
  }

  setMouseWorldPos(_x: number, _y: number): void {}

  setHighlightStructureTypes(_unitTypes: string[] | null): void {}

  // ---------------------------------------------------------------------------
  // Color helper
  // ---------------------------------------------------------------------------

  /**
   * Stable per-player color. When the GPU palette has been routed in via
   * {@link setPalette}, the color is read from `paletteData[smallID*4..+3]`
   * (row 0 = fill colors, RGBA 0-1 floats → 0-255 RGB) so CPU-rendered units
   * match the GPU path. Otherwise the smallID is hashed → HSL → RGB as a
   * distinct-color fallback (each player stays visually distinct even without
   * a palette). Results are memoized in {@link colorCache}.
   */
  private playerColor(smallID: number): RGB {
    const cached = this.colorCache.get(smallID);
    if (cached !== undefined) return cached;
    const palette = this.paletteData;
    let rgb: RGB;
    if (
      palette !== null &&
      smallID > 0 &&
      smallID < PALETTE_SIZE &&
      palette.length >= (smallID + 1) * 4
    ) {
      const base = smallID * 4;
      rgb = [
        Math.round(palette[base] * 255),
        Math.round(palette[base + 1] * 255),
        Math.round(palette[base + 2] * 255),
      ];
    } else {
      const hue = (smallID * 137.508) % 360;
      rgb = hslToRgb(hue, 0.65, 0.55);
    }
    this.colorCache.set(smallID, rgb);
    return rgb;
  }

  /**
   * Rail color for a tile's owner. Rails read the palette's BORDER row
   * (matching GPU `texture(uPalette, vec2((owner+0.5)/PALETTE_SIZE, 0.75))`),
   * except the local player's rails (overridden via {@link setLocalRailColor})
   * and owner 0 (neutral gray, 0.75×255). Falls back to the HSL-hash fill
   * color when the palette lacks the owner.
   */
  private railColor(ownerID: number): RGB {
    if (ownerID === this.localPlayerID && this.localRailColor !== null) {
      return this.localRailColor;
    }
    const palette = this.paletteData;
    if (
      palette !== null &&
      ownerID > 0 &&
      ownerID < PALETTE_SIZE &&
      palette.length >= (PALETTE_SIZE + ownerID + 1) * 4
    ) {
      const base = (PALETTE_SIZE + ownerID) * 4;
      return [
        Math.round(palette[base] * 255),
        Math.round(palette[base + 1] * 255),
        Math.round(palette[base + 2] * 255),
      ];
    }
    if (ownerID === 0) return [191, 191, 191];
    return this.playerColor(ownerID);
  }

  /** Structure icon radius in world tiles (mirrors StructurePass vert shader). */
  private structureRadius(unit: UnitState, zoom: number): number {
    const shapeScale = SHAPE_SCALES[unit.unitType] ?? 1;
    const iconScale = this.iconScaleForZoom(zoom);
    return Math.max(0.5, (ICON_SIZE * iconScale * shapeScale) / zoom / 2);
  }

  private iconScaleForZoom(zoom: number): number {
    if (zoom <= DOTS_ZOOM_THRESHOLD) return DOT_SCALE;
    if (zoom >= ICON_GROW_ZOOM) return zoom / ICON_GROW_ZOOM;
    return Math.min(1, zoom / ICON_SCALE_FACTOR_ZOOMED_OUT);
  }

  // ---------------------------------------------------------------------------
  // Render
  // ---------------------------------------------------------------------------

  draw(ctx: CanvasRenderingContext2D, camera: CanvasCamera): void {
    const canvas = ctx.canvas;
    const canvasW = canvas.width;
    const canvasH = canvas.height;
    const zoom = camera.zoom;
    if (zoom <= 0 || canvasW === 0 || canvasH === 0) return;

    // World → device-pixel projection (matches Camera.worldToScreen but in
    // device pixels, identical to what TerritoryLayer must apply):
    //   screenX = zoom * (worldX - camX) + canvasW / 2
    //   screenY = zoom * (worldY - camY) + canvasH / 2
    ctx.setTransform(
      zoom,
      0,
      0,
      zoom,
      canvasW / 2 - zoom * camera.x,
      canvasH / 2 - zoom * camera.y,
    );

    const halfVpW = canvasW / (2 * zoom);
    const halfVpH = canvasH / (2 * zoom);
    const minWX = camera.x - halfVpW;
    const maxWX = camera.x + halfVpW;
    const minWY = camera.y - halfVpH;
    const maxWY = camera.y + halfVpH;

    this.drawSpawnOverlay(ctx, zoom);
    this.drawRailroads(ctx, zoom, minWX, maxWX, minWY, maxWY);
    this.drawStructuresAndUnits(ctx, zoom, minWX, maxWX, minWY, maxWY);
    this.advanceRailDust();
    this.drawRailroadDust(ctx, zoom, minWX, maxWX, minWY, maxWY);
    this.drawAttackRings(ctx, zoom);
    this.drawNukeTelegraphs(ctx, zoom);
    this.drawNukeTrajectory(ctx, zoom);
    this.drawGhostPreview(ctx, zoom);
    this.drawMoveIndicator(ctx, zoom);

    // Names render in screen space (identity transform) so font sizes are
    // device-pixel stable and crisp.
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    this.drawNames(ctx, camera, canvasW, canvasH);
    ctx.setTransform(1, 0, 0, 1, 0, 0);
  }

  private drawSpawnOverlay(ctx: CanvasRenderingContext2D, zoom: number): void {
    if (!this.spawnActive || this.spawnCenters.length === 0) return;
    ctx.lineWidth = 2 / zoom;
    for (const c of this.spawnCenters) {
      const r = c.isSelf ? SPAWN_SELF_RADIUS : SPAWN_MATE_RADIUS;
      const cr = Math.round(c.r * 255);
      const cg = Math.round(c.g * 255);
      const cb = Math.round(c.b * 255);
      ctx.fillStyle = `rgba(${cr},${cg},${cb},0.22)`;
      ctx.strokeStyle = `rgba(${cr},${cg},${cb},0.9)`;
      ctx.beginPath();
      ctx.arc(c.x, c.y, r, 0, Math.PI * 2);
      ctx.fill();
      ctx.stroke();
    }
  }

  /**
   * Draw railroad tracks in world coords (below units/structures, matching the
   * GPU layer order). One stroked polyline per rail tile, colored by the tile
   * owner (border row of the palette). Fades out as zoom drops below
   * `railMinZoom` (mirrors RailroadPass.draw's zoom fade).
   *
   * Rail types (from railroad.frag.glsl `railLineDist`), tile-local coords:
   *   1 = Vertical, 2 = Horizontal, 3 = TopLeft, 4 = TopRight,
   *   5 = BottomLeft, 6 = BottomRight.
   */
  private drawRailroads(
    ctx: CanvasRenderingContext2D,
    zoom: number,
    minWX: number,
    maxWX: number,
    minWY: number,
    maxWY: number,
  ): void {
    const rs = this.settings.railroad;
    const fadeRange = Math.max(rs.railFadeRange, 0);
    const fadeStart = rs.railMinZoom - fadeRange;
    const fade =
      fadeRange <= 0
        ? zoom >= rs.railMinZoom
          ? 1
          : 0
        : Math.min(1, Math.max(0, (zoom - fadeStart) / fadeRange));
    if (fade <= 0) return;

    const state = this.railroadState;
    const tileState = this.tileState;
    const mapW = this.mapW;
    const mapH = this.mapH;
    if (state === null || tileState === null || mapW <= 0 || mapH <= 0) return;

    const minTx = Math.max(0, Math.floor(minWX));
    const maxTx = Math.min(mapW - 1, Math.ceil(maxWX) - 1);
    const minTy = Math.max(0, Math.floor(minWY));
    const maxTy = Math.min(mapH - 1, Math.ceil(maxWY) - 1);
    if (minTx > maxTx || minTy > maxTy) return;

    const alpha = fade * rs.railAlpha;
    if (alpha <= 0) return;
    ctx.save();
    ctx.globalAlpha = alpha;
    ctx.lineCap = "round";
    ctx.lineJoin = "round";
    ctx.lineWidth = Math.max(0.3, rs.railThickness);

    for (let ty = minTy; ty <= maxTy; ty++) {
      for (let tx = minTx; tx <= maxTx; tx++) {
        const t = ty * mapW + tx;
        const rail = state[t];
        if (rail < 1 || rail > 6) continue;
        const owner = tileState[t] & OWNER_MASK;
        const x0 = tx;
        const x1 = tx + 1;
        const y0 = ty;
        const y1 = ty + 1;
        const cx = tx + 0.5;
        const cy = ty + 0.5;
        ctx.strokeStyle = rgbCss(this.railColor(owner));
        ctx.beginPath();
        switch (rail) {
          case 1: // Vertical
            ctx.moveTo(cx, y0);
            ctx.lineTo(cx, y1);
            break;
          case 2: // Horizontal
            ctx.moveTo(x0, cy);
            ctx.lineTo(x1, cy);
            break;
          case 3: // TopLeft
            ctx.moveTo(cx, cy);
            ctx.lineTo(cx, y0);
            ctx.moveTo(cx, cy);
            ctx.lineTo(x0, cy);
            break;
          case 4: // TopRight
            ctx.moveTo(cx, cy);
            ctx.lineTo(cx, y0);
            ctx.moveTo(cx, cy);
            ctx.lineTo(x1, cy);
            break;
          case 5: // BottomLeft
            ctx.moveTo(cx, cy);
            ctx.lineTo(cx, y1);
            ctx.moveTo(cx, cy);
            ctx.lineTo(x0, cy);
            break;
          default: // 6 = BottomRight
            ctx.moveTo(cx, cy);
            ctx.lineTo(cx, y1);
            ctx.moveTo(cx, cy);
            ctx.lineTo(x1, cy);
            break;
        }
        ctx.stroke();
      }
    }
    ctx.restore();
  }

  /** Advance railroad dust particles and prune dead ones (once per frame). */
  private advanceRailDust(): void {
    const particles = this.railDust;
    if (particles.length === 0) return;
    const now = performance.now();
    let dtMs = 16;
    if (this.lastDustTime !== 0) {
      dtMs = Math.min(100, Math.max(0, now - this.lastDustTime));
    }
    this.lastDustTime = now;
    const dt = dtMs / 1000;
    for (let i = particles.length - 1; i >= 0; i--) {
      const p = particles[i];
      p.x += p.vx * dt;
      p.y += p.vy * dt;
      if (now - p.born >= p.lifeMs) {
        particles[i] = particles[particles.length - 1];
        particles.pop();
      }
    }
  }

  /**
   * Draw railroad-construction dust as small gray-white circles that shrink
   * and fade as their lifetime runs out. World-coord culling keeps the cost
   * proportional to the viewport.
   */
  private drawRailroadDust(
    ctx: CanvasRenderingContext2D,
    zoom: number,
    minWX: number,
    maxWX: number,
    minWY: number,
    maxWY: number,
  ): void {
    const particles = this.railDust;
    if (particles.length === 0) return;
    const now = performance.now();
    const margin = 1; // world-tile cull margin
    ctx.save();
    ctx.fillStyle = "#d8d8d8";
    for (const p of particles) {
      if (p.x < minWX - margin || p.x > maxWX + margin) continue;
      if (p.y < minWY - margin || p.y > maxWY + margin) continue;
      const lifeFrac = 1 - (now - p.born) / p.lifeMs;
      if (lifeFrac <= 0) continue;
      ctx.globalAlpha = 0.5 * lifeFrac;
      ctx.beginPath();
      ctx.arc(p.x, p.y, p.radius * (0.5 + 0.5 * lifeFrac), 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.restore();
  }

  private drawStructuresAndUnits(
    ctx: CanvasRenderingContext2D,
    zoom: number,
    minWX: number,
    maxWX: number,
    minWY: number,
    maxWY: number,
  ): void {
    const mapW = this.mapW;
    if (mapW <= 0) return;
    const margin = 2; // world-tile cull margin

    for (const unit of this.units.values()) {
      if (!unit.isActive) continue;
      const tx = unit.pos % mapW;
      const ty = (unit.pos - tx) / mapW;
      const cx = tx + 0.5;
      const cy = ty + 0.5;
      if (cx < minWX - margin || cx > maxWX + margin) continue;
      if (cy < minWY - margin || cy > maxWY + margin) continue;

      if (STRUCTURE_TYPES.has(unit.unitType)) {
        this.drawStructure(ctx, unit, cx, cy, zoom);
      } else {
        this.drawMobileUnit(ctx, unit, cx, cy, zoom);
      }
    }

    this.drawSelectionRings(ctx, zoom);
  }

  private drawStructure(
    ctx: CanvasRenderingContext2D,
    unit: UnitState,
    cx: number,
    cy: number,
    zoom: number,
  ): void {
    const r = this.structureRadius(unit, zoom);
    const color = this.playerColor(unit.ownerID);
    const highlighted =
      this.highlightOwner !== 0 && unit.ownerID === this.highlightOwner;
    const atlas = this.structureAtlas;
    const atlasCol = STRUCTURE_ATLAS_COL[unit.unitType];

    if (atlas !== null && atlasCol !== undefined) {
      // Player-colored shape backing (national color) with the white
      // build-list icon glyph drawn on top, plus a player-color border ring.
      // The atlas RGB is pure white; alpha carries the icon mask.
      ctx.save();
      if (unit.underConstruction) ctx.globalAlpha = 0.35;
      // 1) Player-color shape backing.
      this.structureShapePath(ctx, unit.unitType, cx, cy, r);
      ctx.fillStyle = highlighted ? rgbaCss(color, 0.9) : rgbaCss(color, 0.7);
      ctx.fill();
      // 2) White icon overlay (atlas alpha mask, RGB all-white).
      ctx.clip();
      ctx.drawImage(
        atlas,
        atlasCol * ATLAS_CELL,
        0,
        ATLAS_CELL,
        ATLAS_CELL,
        cx - r,
        cy - r,
        r * 2,
        r * 2,
      );
      ctx.restore();
      // 3) Player-color border ring so the silhouette is crisp over the icon.
      ctx.strokeStyle = highlighted ? rgbCss(color) : rgbaCss(color, 0.85);
      ctx.lineWidth = Math.max(1 / zoom, r * 0.12);
      this.structureShapePath(ctx, unit.unitType, cx, cy, r);
      ctx.stroke();
    } else {
      // Atlas not ready (or unknown type): plain geometric fallback.
      ctx.lineWidth = 1 / zoom;
      if (unit.underConstruction) {
        ctx.fillStyle = rgbaCss(color, 0.35);
        ctx.strokeStyle = rgbCss(color);
      } else {
        ctx.fillStyle = highlighted ? rgbaCss(color, 1) : rgbCss(color);
        ctx.strokeStyle = "rgba(0,0,0,0.6)";
      }
      this.drawStructureShape(ctx, unit.unitType, cx, cy, r);
    }

    // Level pips when zoomed in enough to see them.
    if (unit.level > 0 && zoom >= 4) {
      const pipR = Math.max(0.4, r * 0.16);
      const spacing = pipR * 2.4;
      const count = Math.min(unit.level, 5);
      const startX = cx - ((count - 1) * spacing) / 2;
      const py = cy + r + pipR * 1.6;
      ctx.fillStyle = "#ffffff";
      for (let i = 0; i < count; i++) {
        ctx.beginPath();
        ctx.arc(startX + i * spacing, py, pipR, 0, Math.PI * 2);
        ctx.fill();
      }
    }
  }

  /**
   * Trace a regular polygon as the current path (no fill/stroke). First
   * vertex at `startAngle` (radians, canvas +Y-down convention).
   */
  private regularPolygon(
    ctx: CanvasRenderingContext2D,
    cx: number,
    cy: number,
    r: number,
    n: number,
    startAngle: number,
  ): void {
    ctx.beginPath();
    for (let i = 0; i < n; i++) {
      const a = startAngle + (i * 2 * Math.PI) / n;
      const px = cx + r * Math.cos(a);
      const py = cy + r * Math.sin(a);
      if (i === 0) {
        ctx.moveTo(px, py);
      } else {
        ctx.lineTo(px, py);
      }
    }
    ctx.closePath();
  }

  /**
   * Build the per-type structure silhouette path (matching the GPU
   * StructurePass shapeSDF so both renderers show the same outline):
   *   City          — circle
   *   Port          — pentagon (vertex up)
   *   Factory       — hexagon (flat top)
   *   Defense Post  — octagon (flat top)
   *   SAM Launcher  — square
   *   Missile Silo  — triangle (vertex up)
   * Unknown types fall back to the City circle.
   */
  private structureShapePath(
    ctx: CanvasRenderingContext2D,
    unitType: string,
    cx: number,
    cy: number,
    r: number,
  ): void {
    switch (unitType) {
      case UT_PORT:
        this.regularPolygon(ctx, cx, cy, r, 5, -Math.PI / 2);
        break;
      case UT_FACTORY:
        this.regularPolygon(ctx, cx, cy, r, 6, 0);
        break;
      case UT_DEFENSE_POST:
        this.regularPolygon(ctx, cx, cy, r, 8, 0);
        break;
      case UT_SAM_LAUNCHER:
        ctx.beginPath();
        ctx.rect(cx - r, cy - r, r * 2, r * 2);
        break;
      case UT_MISSILE_SILO:
        this.regularPolygon(ctx, cx, cy, r, 3, -Math.PI / 2);
        break;
      case UT_CITY:
      default:
        ctx.beginPath();
        ctx.arc(cx, cy, r, 0, Math.PI * 2);
        break;
    }
  }

  /**
   * Draw the per-type structure silhouette. Each branch builds its path then
   * calls fill() + stroke() so fillStyle/strokeStyle set by the caller apply
   * uniformly. Shapes mirror the GPU StructurePass iconography so structure
   * types are distinguishable on the CPU path (not just by radius):
   *   City          — circle
   *   Port          — circle + dark anchor rectangle
   *   Factory       — square
   *   Defense Post  — diamond (45° square)
   *   SAM Launcher  — cross (two intersecting bars)
   *   Missile Silo  — triangle (point up)
   * Unknown types fall back to the City circle.
   */
  private drawStructureShape(
    ctx: CanvasRenderingContext2D,
    unitType: string,
    cx: number,
    cy: number,
    r: number,
  ): void {
    switch (unitType) {
      case UT_FACTORY:
        ctx.beginPath();
        ctx.rect(cx - r, cy - r, r * 2, r * 2);
        ctx.fill();
        ctx.stroke();
        break;
      case UT_DEFENSE_POST:
        ctx.beginPath();
        ctx.moveTo(cx, cy - r);
        ctx.lineTo(cx + r, cy);
        ctx.lineTo(cx, cy + r);
        ctx.lineTo(cx - r, cy);
        ctx.closePath();
        ctx.fill();
        ctx.stroke();
        break;
      case UT_SAM_LAUNCHER: {
        // Cross: horizontal + vertical bars, each arm ~0.4r thick.
        const t = r * 0.4;
        ctx.beginPath();
        ctx.rect(cx - r, cy - t, r * 2, t * 2);
        ctx.fill();
        ctx.stroke();
        ctx.beginPath();
        ctx.rect(cx - t, cy - r, t * 2, r * 2);
        ctx.fill();
        ctx.stroke();
        break;
      }
      case UT_MISSILE_SILO:
        ctx.beginPath();
        ctx.moveTo(cx, cy - r);
        ctx.lineTo(cx + r, cy + r);
        ctx.lineTo(cx - r, cy + r);
        ctx.closePath();
        ctx.fill();
        ctx.stroke();
        break;
      case UT_PORT: {
        // Circle + dark anchor rectangle (bottom-center) for the port mark.
        ctx.beginPath();
        ctx.arc(cx, cy, r, 0, Math.PI * 2);
        ctx.fill();
        ctx.stroke();
        ctx.save();
        ctx.fillStyle = "rgba(0,0,0,0.55)";
        const aw = r * 0.5;
        const ah = r * 0.28;
        ctx.fillRect(cx - aw / 2, cy + r * 0.25 - ah / 2, aw, ah);
        ctx.restore();
        break;
      }
      case UT_CITY:
      default:
        ctx.beginPath();
        ctx.arc(cx, cy, r, 0, Math.PI * 2);
        ctx.fill();
        ctx.stroke();
        break;
    }
  }

  private drawMobileUnit(
    ctx: CanvasRenderingContext2D,
    unit: UnitState,
    cx: number,
    cy: number,
    zoom: number,
  ): void {
    if (HOT_TYPES.has(unit.unitType) || PROJ_TYPES.has(unit.unitType)) {
      // Missiles/nukes/shells: bright dot (visible without a sprite atlas).
      const r = Math.max(0.6, UNIT_SIZE * 0.35);
      ctx.fillStyle = HOT_TYPES.has(unit.unitType) ? "#ff8c1a" : "#ffffff";
      ctx.beginPath();
      ctx.arc(cx, cy, r, 0, Math.PI * 2);
      ctx.fill();
      return;
    }

    const r = UNIT_SIZE / 2;
    const color = this.playerColor(unit.ownerID);
    ctx.fillStyle = rgbCss(color);
    ctx.strokeStyle = "rgba(0,0,0,0.55)";
    ctx.lineWidth = 1 / zoom;
    ctx.beginPath();
    ctx.arc(cx, cy, r, 0, Math.PI * 2);
    ctx.fill();
    ctx.stroke();
  }

  private drawSelectionRings(
    ctx: CanvasRenderingContext2D,
    zoom: number,
  ): void {
    if (this.selectedUnitIds.length === 0) return;
    const mapW = this.mapW;
    if (mapW <= 0) return;
    ctx.strokeStyle = "#ffee44";
    ctx.lineWidth = 2 / zoom;
    for (const id of this.selectedUnitIds) {
      const unit = this.units.get(id);
      if (unit === undefined || !unit.isActive) continue;
      const tx = unit.pos % mapW;
      const ty = (unit.pos - tx) / mapW;
      const r = STRUCTURE_TYPES.has(unit.unitType)
        ? Math.max(1.4, this.structureRadius(unit, zoom) * 1.25)
        : UNIT_SIZE * 0.75;
      ctx.beginPath();
      ctx.arc(tx + 0.5, ty + 0.5, r, 0, Math.PI * 2);
      ctx.stroke();
    }
  }

  private drawAttackRings(ctx: CanvasRenderingContext2D, zoom: number): void {
    if (this.attackRings.length === 0) return;
    const r = ATTACK_RING_SCREEN_PX / zoom;
    ctx.strokeStyle = "rgba(255,60,60,0.9)";
    ctx.lineWidth = 2 / zoom;
    for (const ring of this.attackRings) {
      ctx.beginPath();
      ctx.arc(ring.x, ring.y, r, 0, Math.PI * 2);
      ctx.stroke();
    }
  }

  private drawNukeTelegraphs(
    ctx: CanvasRenderingContext2D,
    zoom: number,
  ): void {
    if (this.nukeTelegraphs.length === 0) return;
    ctx.lineWidth = 1.5 / zoom;
    for (const t of this.nukeTelegraphs) {
      const rgb: RGB =
        t.relation === 0
          ? [80, 255, 120]
          : t.relation === 1
            ? [120, 160, 255]
            : [255, 80, 80];
      ctx.fillStyle = rgbaCss(rgb, 0.15);
      ctx.strokeStyle = rgbaCss(rgb, 0.85);
      ctx.beginPath();
      ctx.arc(t.x, t.y, t.outerRadius, 0, Math.PI * 2);
      ctx.fill();
      ctx.stroke();
      if (t.innerRadius > 0) {
        ctx.beginPath();
        ctx.arc(t.x, t.y, t.innerRadius, 0, Math.PI * 2);
        ctx.stroke();
      }
    }
  }

  private drawNukeTrajectory(
    ctx: CanvasRenderingContext2D,
    zoom: number,
  ): void {
    const t = this.nukeTrajectory;
    if (t === null) return;
    ctx.strokeStyle = "rgba(255,200,80,0.9)";
    ctx.lineWidth = 2 / zoom;
    ctx.beginPath();
    const steps = 32;
    for (let i = 0; i <= steps; i++) {
      const u = i / steps;
      const x = cubicBez(t.p0x, t.p1x, t.p2x, t.p3x, u);
      const y = cubicBez(t.p0y, t.p1y, t.p2y, t.p3y, u);
      if (i === 0) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    }
    ctx.stroke();
  }

  private drawGhostPreview(ctx: CanvasRenderingContext2D, zoom: number): void {
    const g = this.ghostPreview;
    if (g === null) return;
    const cx = g.tileX + 0.5;
    const cy = g.tileY + 0.5;
    ctx.lineWidth = 2 / zoom;
    if (g.rangeRadius > 0) {
      ctx.strokeStyle = g.canBuild
        ? "rgba(120,255,120,0.7)"
        : "rgba(255,80,80,0.7)";
      ctx.beginPath();
      ctx.arc(cx, cy, g.rangeRadius, 0, Math.PI * 2);
      ctx.stroke();
    }
    ctx.fillStyle = g.canBuild
      ? "rgba(120,255,120,0.45)"
      : "rgba(255,80,80,0.45)";
    ctx.fillRect(cx - 0.4, cy - 0.4, 0.8, 0.8);
  }

  private drawMoveIndicator(ctx: CanvasRenderingContext2D, zoom: number): void {
    const m = this.moveIndicator;
    if (m === null) return;
    const cx = m.tileX + 0.5;
    const cy = m.tileY + 0.5;
    ctx.fillStyle = rgbCss(this.playerColor(m.ownerID));
    ctx.strokeStyle = "rgba(255,255,255,0.9)";
    ctx.lineWidth = 1.5 / zoom;
    ctx.beginPath();
    ctx.arc(cx, cy, 0.5, 0, Math.PI * 2);
    ctx.fill();
    ctx.stroke();
  }

  private drawNames(
    ctx: CanvasRenderingContext2D,
    camera: CanvasCamera,
    canvasW: number,
    canvasH: number,
  ): void {
    if (this.names.size === 0) return;
    const zoom = camera.zoom;
    const margin = 64;
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    for (const entry of this.names.values()) {
      const sx = zoom * (entry.x - camera.x) + canvasW / 2;
      const sy = zoom * (entry.y - camera.y) + canvasH / 2;
      if (
        sx < -margin ||
        sx > canvasW + margin ||
        sy < -margin ||
        sy > canvasH + margin
      ) {
        continue;
      }
      const fontPx = Math.max(
        8,
        Math.min(64, entry.size * NAME_SCALE_FACTOR * zoom),
      );
      if (fontPx < 8) continue;
      const label = this.displayNames.get(entry.playerID) ?? entry.playerID;
      ctx.font = `${Math.round(fontPx)}px sans-serif`;
      ctx.lineWidth = Math.max(2, fontPx * 0.18);
      ctx.strokeStyle = "rgba(0,0,0,0.85)";
      ctx.fillStyle = "#ffffff";
      ctx.strokeText(label, sx, sy);
      ctx.fillText(label, sx, sy);
    }
  }

  dispose(): void {
    this.units.clear();
    this.structures.clear();
    this.names.clear();
    this.displayNames.clear();
    this.players.clear();
    this.selectedUnitIds = [];
    this.attackRings = [];
    this.nukeTelegraphs = [];
    this.nukeTrajectory = null;
    this.ghostPreview = null;
    this.moveIndicator = null;
    this.spawnCenters = [];
    this.colorCache.clear();
    this.paletteData = null;
    this.tileState = null;
    this.railroadState = null;
    this.railroadDirty = false;
    this.localRailColor = null;
    this.railDust = [];
    this.lastDustTime = 0;
  }
}
