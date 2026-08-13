import { chooseBackend } from "../../../../src/client/render/gl/initGL";

// WEBGL_debug_renderer_info.UNMASKED_RENDERER_WEBGL
const UNMASKED_RENDERER_WEBGL = 0x9246;
// GL_MAX_TEXTURE_SIZE (3379)
const MAX_TEXTURE_SIZE = 0x0d33;

// jsdom has no WebGL, so stand in a minimal fake context. When `renderer` is
// provided the fake exposes WEBGL_debug_renderer_info reporting it.
// `maxTextureSize` defaults to a typical desktop-GPU value. Mirrors the helper
// in tests/client/initGL.test.ts.
function fakeContext(
  renderer?: string,
  maxTextureSize = 16384,
): WebGL2RenderingContext {
  return {
    MAX_TEXTURE_SIZE,
    getExtension: (name: string) =>
      name === "WEBGL_debug_renderer_info" && renderer !== undefined
        ? { UNMASKED_RENDERER_WEBGL }
        : null,
    getParameter: (param: number) =>
      param === UNMASKED_RENDERER_WEBGL
        ? renderer
        : param === MAX_TEXTURE_SIZE
          ? maxTextureSize
          : null,
  } as unknown as WebGL2RenderingContext;
}

// initGL distinguishes the accelerated request from the probe by the presence
// of failIfMajorPerformanceCaveat in the attrs, so the stub branches on it.
function stubGetContext(opts: {
  accelerated: WebGL2RenderingContext | null;
  probe: WebGL2RenderingContext | null;
}) {
  return vi
    .spyOn(HTMLCanvasElement.prototype, "getContext")
    .mockImplementation(((_type: string, attrs?: WebGLContextAttributes) =>
      attrs?.failIfMajorPerformanceCaveat
        ? opts.accelerated
        : opts.probe) as any);
}

describe("chooseBackend", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("forceCpu=true returns cpu/forced without probing GL", () => {
    // A real GPU context is wired up so any accidental GL probe would flip the
    // result to gpu; the not.toHaveBeenCalled assertion is the primary guard
    // that forceCpu short-circuits before touching GL.
    const spy = stubGetContext({
      accelerated: fakeContext("ANGLE (NVIDIA)", 16384),
      probe: fakeContext(),
    });

    const res = chooseBackend(document.createElement("canvas"), {}, true);

    expect(res.backend).toBe("cpu");
    expect(res.status).toBe("forced");
    expect(spy).not.toHaveBeenCalled();
  });

  it("returns cpu when getContext('webgl2') returns null (unsupported)", () => {
    stubGetContext({ accelerated: null, probe: null });

    const res = chooseBackend(document.createElement("canvas"));

    expect(res.backend).toBe("cpu");
    expect(res.status).toBe("unsupported");
  });

  it("returns cpu/software when the unmasked renderer is SwiftShader", () => {
    stubGetContext({
      accelerated: fakeContext("SwiftShader", 8192),
      probe: null,
    });

    const res = chooseBackend(document.createElement("canvas"));

    expect(res.backend).toBe("cpu");
    expect(res.status).toBe("software");
    if (res.status === "software") {
      expect(res.renderer).toBe("SwiftShader");
    }
  });

  it("returns gpu/ok with the accelerated context for a hardware renderer", () => {
    const accel = fakeContext("ANGLE (NVIDIA)", 16384);
    stubGetContext({ accelerated: accel, probe: null });

    const res = chooseBackend(document.createElement("canvas"));

    expect(res.backend).toBe("gpu");
    if (res.backend === "gpu") {
      expect(res.status).toBe("ok");
      expect(res.gl).toBe(accel);
      expect(res.renderer).toBe("ANGLE (NVIDIA)");
    }
  });
});
