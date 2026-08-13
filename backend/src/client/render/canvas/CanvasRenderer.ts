/**
 * CanvasRenderer — CPU (Canvas2D) fallback backend.
 *
 * Implements the same {@link RendererBackend} surface as {@link GPURenderer}
 * so {@link MapRenderer} can dispatch to either. This skeleton acquires a 2D
 * context, drives a RAF loop (captured by the caller, same as the GPU path),
 * and draws a placeholder so the game visibly launches in CPU mode. The real
 * per-pass rendering (territory, units, effects) is filled in by Tasks 3/4/5;
 * until then most methods are no-ops that delegate to stub layer modules.
 */

import type { Config } from "../../../core/configuration/Config";
import type { MapLayer } from "../../../core/game/TerrainMapLoader";
import type { SpiralRibbon } from "../frame/SpiralTrails";
import { GLUnavailableError } from "../gl/initGL";
import type { SpawnCenter } from "../gl/passes/SpawnOverlayPass";
import type { AttackTroopLabel } from "../gl/passes/WorldTextPass";
import type { RenderSettings } from "../gl/RenderSettings";
import { renderDpr } from "../gl/utils/Dpr";
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
  PlayerStatic,
  PlayerStatusData,
  RendererConfig,
  UnitState,
} from "../types";
import { EffectsPolicy } from "./EffectsPolicy";
import type { RendererBackend } from "./RendererBackend";
import type { CanvasCamera } from "./TerritoryLayer";
import { TerritoryLayer } from "./TerritoryLayer";
import { UnitLayer } from "./UnitLayer";

const CPU_MODE_LABEL = "CPU rendering mode (GPU unavailable)";

export class CanvasRenderer implements RendererBackend {
  private canvas: HTMLCanvasElement;
  private ctx: CanvasRenderingContext2D | null;
  private settings: RenderSettings;
  private raf: typeof requestAnimationFrame;
  private caf: typeof cancelAnimationFrame;
  private animId: number | null = null;
  private mapW: number;
  private mapH: number;
  private camera: CanvasCamera = { x: 0, y: 0, zoom: 1 };

  private territoryLayer: TerritoryLayer;
  private unitLayer: UnitLayer;
  private effectsPolicy: EffectsPolicy;

  constructor(
    canvas: HTMLCanvasElement,
    header: RendererConfig,
    terrainSource: () => Uint8Array,
    paletteData: Float32Array,
    config: Config,
    settings: RenderSettings,
    raf: typeof requestAnimationFrame = requestAnimationFrame.bind(window),
    caf: typeof cancelAnimationFrame = cancelAnimationFrame.bind(window),
  ) {
    this.canvas = canvas;
    this.settings = settings;
    this.raf = raf;
    this.caf = caf;
    this.mapW = header.mapWidth;
    this.mapH = header.mapHeight;

    // Acquire a 2D context. Reuse GLUnavailableError so the outer game-start
    // catch still gates the user when even Canvas2D is unavailable — this is
    // the final fallback (canvas2d exists virtually everywhere WebGL2 does).
    const ctx = canvas.getContext("2d");
    if (!ctx) {
      throw new GLUnavailableError("unsupported", "canvas2d-unavailable");
    }
    this.ctx = ctx;

    this.territoryLayer = new TerritoryLayer(
      this.mapW,
      this.mapH,
      terrainSource,
      settings,
    );
    this.unitLayer = new UnitLayer(this.mapW, this.mapH);
    this.effectsPolicy = new EffectsPolicy(settings);

    this.startLoop();
  }

  /** CPU path has no texture-size limit. */
  get glLimited(): { renderer: string; maxTextureSize: number } | null {
    return null;
  }

  // ---------------------------------------------------------------------------
  // Canvas / Camera
  // ---------------------------------------------------------------------------

  resize(cssWidth: number, cssHeight: number): void {
    const dpr = renderDpr();
    this.canvas.width = Math.round(cssWidth * dpr);
    this.canvas.height = Math.round(cssHeight * dpr);
  }

  setCameraState(x: number, y: number, z: number): void {
    this.camera = { x, y, zoom: z };
  }

  // ---------------------------------------------------------------------------
  // Data upload
  // ---------------------------------------------------------------------------

  uploadLiveDelta(
    tileState: Uint16Array,
    changedTiles: readonly number[],
  ): void {
    this.territoryLayer.updateTileState(tileState, changedTiles);
  }

  // TODO(canvas): implement trail state in Task 3
  uploadLiveTrailDelta(
    _trailState: Uint16Array,
    _dirtyRowMin: number,
    _dirtyRowMax: number,
  ): void {}

  uploadTileAndTrailState(
    tileState: Uint16Array,
    _trailState: Uint16Array,
  ): void {
    this.territoryLayer.uploadFullTileState(tileState);
    // TODO(canvas): implement trail state in Task 3
  }

  updateSpiralRibbons(ribbons: readonly SpiralRibbon[]): void {
    this.unitLayer.updateSpiralRibbons(ribbons);
  }

  updatePalette(paletteData: Float32Array): void {
    this.territoryLayer.setPalette(paletteData);
    this.unitLayer.setPalette(paletteData);
  }

  // TODO(canvas): implement effect palette in Task 5
  updateEffectPalette(_effectData: Float32Array): void {}

  addPlayers(
    players: PlayerStatic[],
    paletteData: Float32Array,
    patternMeta: Float32Array,
    patternData: Uint8Array,
  ): void {
    this.territoryLayer.addPlayers(
      players,
      paletteData,
      patternMeta,
      patternData,
    );
    this.unitLayer.setPalette(paletteData);
  }

  setPlayerSkin(smallID: number, url: string): void {
    this.unitLayer.setPlayerSkin(smallID, url);
  }

  initSkinAtlas(urls: readonly string[]): void {
    this.unitLayer.initSkinAtlas(urls);
  }

  setPlayerSpawn(smallID: number, x: number, y: number): void {
    this.unitLayer.setPlayerSpawn(smallID, x, y);
  }

  uploadRailroadState(data: Uint8Array): void {
    this.unitLayer.uploadRailroadState(data);
  }

  updateUnits(units: Map<number, UnitState>, gameTick: number): void {
    this.unitLayer.updateUnits(units, gameTick);
  }

  updateNames(
    names: Map<string, NameEntry>,
    players: Map<number, PlayerState>,
    snap: boolean,
    statusData?: Map<number, PlayerStatusData>,
  ): void {
    this.unitLayer.updateNames(names, players, snap, statusData);
  }

  refreshNames(displayNames: Map<string, string>): void {
    this.unitLayer.refreshNames(displayNames);
  }

  // Relations matrix flows to TerritoryLayer so border classification can
  // respond to relationship changes (markAllDirty triggers a full recompute).
  updateRelations(data: Uint8Array, size: number): void {
    this.territoryLayer.updateRelations(data, size);
  }

  updateStructures(units: Map<number, UnitState>): void {
    this.unitLayer.updateStructures(units);
  }

  applyDeadUnits(deadUnits: DeadUnitFx[]): void {
    this.unitLayer.applyDeadUnits(deadUnits);
  }

  applyConquestEvents(events: ConquestFx[]): void {
    this.unitLayer.applyConquestEvents(events);
  }

  setAttackTroopLabels(labels: AttackTroopLabel[]): void {
    this.unitLayer.setAttackTroopLabels(labels);
  }

  applyBonusEvents(events: BonusEvent[]): void {
    this.unitLayer.applyBonusEvents(events);
  }

  applyRailroadDust(tileRefs: number[]): void {
    this.unitLayer.applyRailroadDust(tileRefs);
  }

  applyTerrainDelta(refs: readonly number[], terrainBytes: Uint8Array): void {
    this.territoryLayer.applyTerrainDelta(refs, terrainBytes);
  }

  rebuildTerrain(): void {
    this.territoryLayer.rebuildTerrain();
  }

  updateAttackRings(rings: AttackRingInput[]): void {
    this.unitLayer.updateAttackRings(rings);
  }

  updateGhostPreview(data: GhostPreviewData | null): void {
    this.unitLayer.updateGhostPreview(data);
  }

  // ---------------------------------------------------------------------------
  // Nuke UI
  // ---------------------------------------------------------------------------

  updateNukeTrajectory(data: NukeTrajectoryData | null): void {
    this.unitLayer.updateNukeTrajectory(data);
  }

  updateNukeTelegraphs(data: NukeTelegraphData[]): void {
    this.unitLayer.updateNukeTelegraphs(data);
  }

  updateSpawnOverlay(inSpawnPhase: boolean, centers: SpawnCenter[]): void {
    this.unitLayer.updateSpawnOverlay(inSpawnPhase, centers);
  }

  updateSmallPlayerGlow(set: Uint8Array | null): void {
    this.unitLayer.updateSmallPlayerGlow(set);
  }

  // ---------------------------------------------------------------------------
  // Map layers
  // ---------------------------------------------------------------------------

  setMapLayers(layers: MapLayer[], images: Map<string, ImageBitmap>): void {
    this.unitLayer.setMapLayers(layers, images);
  }

  setLayerVisible(layerId: string, visible: boolean): void {
    this.unitLayer.setLayerVisible(layerId, visible);
  }

  markLayerTilesDestroyed(layerId: string, tileIndices: number[]): void {
    this.unitLayer.markLayerTilesDestroyed(layerId, tileIndices);
  }

  setLayerDestroyedMask(layerId: string, mask: Uint8Array): void {
    this.unitLayer.setLayerDestroyedMask(layerId, mask);
  }

  // ---------------------------------------------------------------------------
  // Selection box
  // ---------------------------------------------------------------------------

  setSelectedUnits(unitIds: readonly number[]): void {
    this.unitLayer.setSelectedUnits(unitIds);
  }

  showMoveIndicator(tileX: number, tileY: number, ownerID: number): void {
    this.unitLayer.showMoveIndicator(tileX, tileY, ownerID);
  }

  // ---------------------------------------------------------------------------
  // SAM radius
  // ---------------------------------------------------------------------------

  setSAMAllianceClusters(clusters: Map<number, number>): void {
    this.unitLayer.setSAMAllianceClusters(clusters);
  }

  // ---------------------------------------------------------------------------
  // Other
  // ---------------------------------------------------------------------------

  setLocalPlayerID(id: number): void {
    this.unitLayer.setLocalPlayerID(id);
    this.territoryLayer.setLocalPlayerID(id);
  }

  setLocalRailColor(r: number, g: number, b: number): void {
    this.unitLayer.setLocalRailColor(r, g, b);
  }

  setAltView(active: boolean): void {
    this.unitLayer.setAltView(active);
  }

  setGridView(active: boolean): void {
    this.unitLayer.setGridView(active);
  }

  setShowPatterns(active: boolean): void {
    this.unitLayer.setShowPatterns(active);
  }

  setHighlightOwner(ownerID: number): void {
    this.unitLayer.setHighlightOwner(ownerID);
  }

  setMouseWorldPos(x: number, y: number): void {
    this.unitLayer.setMouseWorldPos(x, y);
  }

  setHighlightStructureTypes(unitTypes: string[] | null): void {
    this.unitLayer.setHighlightStructureTypes(unitTypes);
  }

  getSettings(): RenderSettings {
    return this.settings;
  }

  // ---------------------------------------------------------------------------
  // Lifecycle
  // ---------------------------------------------------------------------------

  // TODO(canvas): replace placeholder with real layer compositing (Task 3/4/5)
  draw(): void {
    const ctx = this.ctx;
    if (!ctx) return;
    const w = this.canvas.width;
    const h = this.canvas.height;
    ctx.save();
    ctx.fillStyle = this.settings.terrain.oceanColor;
    ctx.fillRect(0, 0, w, h);
    this.territoryLayer.draw(ctx, this.camera);
    this.unitLayer.draw(ctx, this.camera);
    ctx.fillStyle = "rgba(255, 255, 255, 0.85)";
    ctx.font = `${Math.max(14, Math.round(h / 30))}px sans-serif`;
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillText(CPU_MODE_LABEL, w / 2, h / 2);
    ctx.restore();
  }

  private renderLoop = (): void => {
    this.draw();
    this.animId = this.raf(this.renderLoop);
  };

  private startLoop(): void {
    this.animId ??= this.raf(this.renderLoop);
  }

  private stopLoop(): void {
    if (this.animId !== null) {
      this.caf(this.animId);
      this.animId = null;
    }
  }

  dispose(): void {
    this.stopLoop();
    this.territoryLayer.dispose();
    this.unitLayer.dispose();
    this.ctx = null;
  }
}
