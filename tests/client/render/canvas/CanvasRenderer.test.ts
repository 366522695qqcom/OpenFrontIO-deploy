import { CanvasRenderer } from "../../../../src/client/render/canvas/CanvasRenderer";
import { createRenderSettings } from "../../../../src/client/render/gl/RenderSettings";
import type { RendererConfig } from "../../../../src/client/render/types/Renderer";
import type { Config } from "../../../../src/core/configuration/Config";

const header: RendererConfig = {
  mapWidth: 4,
  mapHeight: 4,
  unitTypes: [],
  players: [],
  maxPlayers: 2,
};
const terrainSource = (): Uint8Array => new Uint8Array(16);
const palette = new Float32Array(4096 * 2 * 4);

describe("CanvasRenderer (CPU backend)", () => {
  it("constructs, ingests state, renders a frame, and disposes without throwing", () => {
    const canvas = document.createElement("canvas");

    // Capture the RAF callback so we can drive exactly one draw() frame on
    // demand. The render loop reschedules itself, so we only invoke the first
    // captured callback (guarded by the `capturedCb` check below).
    let capturedCb: FrameRequestCallback | null = null;
    const stubRaf = (cb: FrameRequestCallback): number => {
      capturedCb = cb;
      return 1;
    };
    const stubCaf = (): void => {};

    // 1. Construction must not throw (the canvas mock provides a 2D context).
    let view!: CanvasRenderer;
    expect(() => {
      view = new CanvasRenderer(
        canvas,
        header,
        terrainSource,
        palette,
        null as unknown as Config,
        createRenderSettings(),
        stubRaf,
        stubCaf,
      );
    }).not.toThrow();

    // 2. Ingest a representative batch of per-frame state.
    expect(() => {
      view.setCameraState(2, 2, 1);
      view.uploadTileAndTrailState(new Uint16Array(16), new Uint16Array(16));
      view.updatePalette(palette);
      view.addPlayers([], palette, new Float32Array(0), new Uint8Array(0));
      view.updateUnits(new Map(), 0);
      view.updateStructures(new Map());
      view.updateNames(new Map(), new Map(), false);
    }).not.toThrow();

    // 3. Drive one draw() frame via the captured RAF callback.
    expect(capturedCb).not.toBeNull();
    expect(() =>
      (capturedCb as FrameRequestCallback)(performance.now()),
    ).not.toThrow();

    // 4. CPU backend has no texture-size limit.
    expect(view.glLimited).toBeNull();

    // 5. Teardown must not throw.
    expect(() => view.dispose()).not.toThrow();
  });
});
