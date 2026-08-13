import { MapRenderer } from "../../../../src/client/render/gl/MapRenderer";
import { createRenderSettings } from "../../../../src/client/render/gl/RenderSettings";
import type { RendererConfig } from "../../../../src/client/render/types/Renderer";
import type { Config } from "../../../../src/core/configuration/Config";

// jsdom doesn't ship ResizeObserver; MapRenderer's constructor wires one up to
// drive canvas resizing, so install a no-op stand-in for these tests.
class StubResizeObserver {
  observe(): void {}
  unobserve(): void {}
  disconnect(): void {}
}

const header: RendererConfig = {
  mapWidth: 4,
  mapHeight: 4,
  unitTypes: [],
  players: [],
  maxPlayers: 2,
};
const terrainSource = (): Uint8Array => new Uint8Array(16);
const palette = new Float32Array(4096 * 2 * 4);

// raf/caf stubs: capture but never invoke, so no draw frames run during the
// test (we only exercise construction + teardown here).
const stubRaf = (): number => 0;
const stubCaf = (): void => {};

describe("MapRenderer facade (CPU backend)", () => {
  beforeAll(() => {
    globalThis.ResizeObserver =
      StubResizeObserver as unknown as typeof ResizeObserver;
  });

  it("forceCpu=true dispatches to the CanvasRenderer (cpu) backend", () => {
    const canvas = document.createElement("canvas");
    const view = new MapRenderer(
      canvas,
      header,
      terrainSource,
      palette,
      null as unknown as Config,
      createRenderSettings(),
      stubRaf,
      stubCaf,
      true,
    );

    expect(view.backend).toBe("cpu");
    expect(view.glLimited).toBeNull();

    expect(() => view.dispose()).not.toThrow();
  });

  // The GPU path (MapRenderer with forceCpu=false) isn't constructable in
  // jsdom: GPURenderer needs real WebGL2 extensions, texture setup, and shader
  // compilation that vitest-canvas-mock doesn't provide. The gpu-backend
  // dispatch decision (chooseBackend -> "gpu") is covered by
  // chooseBackend.test.ts instead, so the full GPURenderer pipeline is skipped
  // here.
  it.skip("GPU path is covered by chooseBackend.test.ts (not constructable in jsdom)", () => {
    // Intentionally empty: see the comment above.
  });
});
