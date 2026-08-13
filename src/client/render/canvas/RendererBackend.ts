/**
 * RendererBackend — the method surface MapRenderer delegates to.
 *
 * Satisfied structurally by both the WebGL2 {@link GPURenderer} and the
 * Canvas2D {@link CanvasRenderer}, so the MapRenderer facade can dispatch to
 * either without the callers caring which backend is active. `onContextRestored`
 * is intentionally NOT part of this interface — it stays on MapRenderer (it is
 * a GPU-only concept and the owner wires the re-upload callback there).
 */

import type { MapLayer } from "../../../core/game/TerrainMapLoader";
import type { SpiralRibbon } from "../frame/SpiralTrails";
import type { SpawnCenter } from "../gl/passes/SpawnOverlayPass";
import type { AttackTroopLabel } from "../gl/passes/WorldTextPass";
import type { RenderSettings } from "../gl/RenderSettings";
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
  UnitState,
} from "../types";

export interface RendererBackend {
  /** GPU-only limit info; null on the CPU backend (no texture-size cap). */
  readonly glLimited: { renderer: string; maxTextureSize: number } | null;

  // ---- Canvas / Camera ----

  resize(cssWidth: number, cssHeight: number): void;
  setCameraState(x: number, y: number, z: number): void;

  // ---- Data upload ----

  uploadLiveDelta(
    tileState: Uint16Array,
    changedTiles: readonly number[],
  ): void;
  uploadLiveTrailDelta(
    trailState: Uint16Array,
    dirtyRowMin: number,
    dirtyRowMax: number,
  ): void;
  uploadTileAndTrailState(
    tileState: Uint16Array,
    trailState: Uint16Array,
  ): void;
  updateSpiralRibbons(ribbons: readonly SpiralRibbon[]): void;
  updatePalette(paletteData: Float32Array): void;
  updateEffectPalette(effectData: Float32Array): void;
  addPlayers(
    players: PlayerStatic[],
    paletteData: Float32Array,
    patternMeta: Float32Array,
    patternData: Uint8Array,
  ): void;
  setPlayerSkin(smallID: number, url: string): void;
  initSkinAtlas(urls: readonly string[]): void;
  setPlayerSpawn(smallID: number, x: number, y: number): void;
  uploadRailroadState(data: Uint8Array): void;
  updateUnits(units: Map<number, UnitState>, gameTick: number): void;
  updateNames(
    names: Map<string, NameEntry>,
    players: Map<number, PlayerState>,
    snap: boolean,
    statusData?: Map<number, PlayerStatusData>,
  ): void;
  refreshNames(displayNames: Map<string, string>): void;
  updateRelations(data: Uint8Array, size: number): void;
  updateStructures(units: Map<number, UnitState>): void;
  applyDeadUnits(deadUnits: DeadUnitFx[]): void;
  applyConquestEvents(events: ConquestFx[]): void;
  setAttackTroopLabels(labels: AttackTroopLabel[]): void;
  applyBonusEvents(events: BonusEvent[]): void;
  applyRailroadDust(tileRefs: number[]): void;
  applyTerrainDelta(refs: readonly number[], terrainBytes: Uint8Array): void;
  rebuildTerrain(): void;
  updateAttackRings(rings: AttackRingInput[]): void;
  updateGhostPreview(data: GhostPreviewData | null): void;

  // ---- Nuke UI ----

  updateNukeTrajectory(data: NukeTrajectoryData | null): void;
  updateNukeTelegraphs(data: NukeTelegraphData[]): void;
  updateSpawnOverlay(inSpawnPhase: boolean, centers: SpawnCenter[]): void;
  updateSmallPlayerGlow(set: Uint8Array | null): void;

  // ---- Map layers ----

  setMapLayers(layers: MapLayer[], images: Map<string, ImageBitmap>): void;
  setLayerVisible(layerId: string, visible: boolean): void;
  markLayerTilesDestroyed(layerId: string, tileIndices: number[]): void;
  setLayerDestroyedMask(layerId: string, mask: Uint8Array): void;

  // ---- Selection box ----

  setSelectedUnits(unitIds: readonly number[]): void;
  showMoveIndicator(tileX: number, tileY: number, ownerID: number): void;

  // ---- SAM radius ----

  setSAMAllianceClusters(clusters: Map<number, number>): void;

  // ---- Other ----

  setLocalPlayerID(id: number): void;
  setLocalRailColor(r: number, g: number, b: number): void;
  setAltView(active: boolean): void;
  setGridView(active: boolean): void;
  setShowPatterns(active: boolean): void;
  setHighlightOwner(ownerID: number): void;
  setMouseWorldPos(x: number, y: number): void;
  setHighlightStructureTypes(unitTypes: string[] | null): void;
  getSettings(): RenderSettings;

  // ---- Lifecycle ----

  dispose(): void;
}
