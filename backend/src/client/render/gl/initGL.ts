/**
 * WebGL2 context acquisition that demands a GPU-accelerated context.
 *
 * Software-rendered WebGL (SwiftShader/llvmpipe — hardware acceleration off,
 * blocklisted driver, or a locked-down machine) runs the game at ~1fps, which
 * is unplayable. `failIfMajorPerformanceCaveat: true` forces a real GPU
 * context: Chrome returns null instead of silently handing back a software
 * context. We branch on that to gate the user with an actionable message
 * rather than running at 1fps.
 */

import type { WebGLGateStatus } from "../../components/WebGLGate";
import { getPaletteSize } from "./utils/ColorUtils";

export type GLResult =
  | { gl: WebGL2RenderingContext; status: "ok" }
  | {
      gl: WebGL2RenderingContext;
      status: "limited";
      renderer: string;
      maxTextureSize: number;
    }
  | { gl: null; status: "software" | "unsupported"; renderer: string };

// The renderer unconditionally allocates a PALETTE_SIZE-wide (4096) palette
// texture, so a context whose MAX_TEXTURE_SIZE is below that renders wrong:
// the oversized texImage2D calls fail silently and territory/map areas come
// out black (#4357). In practice this means fingerprinting protection —
// privacy.resistFingerprinting (on by default in LibreWolf, opt-in in
// Firefox) caps MAX_TEXTURE_SIZE at 2048. "limited" still returns the
// context: the player is warned with fix instructions but may continue.
const REQUIRED_TEXTURE_SIZE = getPaletteSize();

// Renderer strings reported by software WebGL backends. Mirrors the detection
// in utilities/Diagnostic.ts.
const SOFTWARE_RENDERER = /swiftshader|llvmpipe|software/i;

/** Read the unmasked GPU renderer string, or "unknown" if unavailable. */
function readRenderer(gl: WebGL2RenderingContext): string {
  const dbg = gl.getExtension("WEBGL_debug_renderer_info");
  return dbg ? String(gl.getParameter(dbg.UNMASKED_RENDERER_WEBGL)) : "unknown";
}

/**
 * Acquire a GPU-accelerated WebGL2 context on `canvas`.
 *
 * @param attrs Context attributes to merge with the mandatory
 *   `failIfMajorPerformanceCaveat: true`. A second `getContext("webgl2")`
 *   call on the same canvas returns the already-created context (ignoring
 *   attrs), so these must be the attributes the renderer wants.
 */
export function initGL(
  canvas: HTMLCanvasElement,
  attrs: WebGLContextAttributes = {},
): GLResult {
  // 1. demand a GPU-accelerated context
  const accel = canvas.getContext("webgl2", {
    ...attrs,
    failIfMajorPerformanceCaveat: true,
  });
  if (accel) {
    // failIfMajorPerformanceCaveat does NOT reliably reject a software context
    // when hardware acceleration is turned off in browser settings (as opposed
    // to a blocklisted driver) — Chrome still hands back a SwiftShader context.
    // So inspect the renderer and gate if it's software; the game is unplayable
    // (~1fps) on it either way.
    const renderer = readRenderer(accel);
    if (SOFTWARE_RENDERER.test(renderer)) {
      return { gl: null, status: "software", renderer };
    }
    // Fingerprinting protection caps texture sizes on an otherwise
    // hardware-accelerated context; the map renders with black areas (#4357).
    const maxTextureSize = Number(accel.getParameter(accel.MAX_TEXTURE_SIZE));
    if (maxTextureSize < REQUIRED_TEXTURE_SIZE) {
      return { gl: accel, status: "limited", renderer, maxTextureSize };
    }
    return { gl: accel, status: "ok" };
  }

  // 2. probe what's actually available. A canvas locks to the first context
  // that *succeeds*; the failed (null) call above does NOT lock it, but we use
  // a throwaway canvas here regardless to avoid any chance of context lock-in.
  const probe = document.createElement("canvas").getContext("webgl2");
  if (!probe) return { gl: null, status: "unsupported", renderer: "" };

  // WebGL2 exists but couldn't be obtained accelerated → treat as software.
  return { gl: null, status: "software", renderer: readRenderer(probe) };
}

/**
 * Thrown by the renderer when a GPU-accelerated WebGL2 context can't be
 * obtained. Carries the detected status + renderer so the caller can gate the
 * user and log the outcome.
 */
export class GLUnavailableError extends Error {
  constructor(
    readonly glStatus: "software" | "unsupported",
    readonly renderer: string,
  ) {
    super(`WebGL2 unavailable: ${glStatus}`);
    this.name = "GLUnavailableError";
  }
}

/**
 * Report the WebGL2 GPU-init outcome to analytics (Google Tag). Fires on every
 * session so we can size the share of users on a software or missing WebGL2
 * context. `renderer` is the unmasked GPU string for non-ok outcomes, empty
 * otherwise.
 */
export function trackGLInit(
  status: "ok" | "software" | "unsupported" | "limited",
  renderer: string,
  maxTextureSize?: number,
): void {
  window.gtag?.("event", "gl_init", {
    status,
    renderer: status === "ok" ? "" : renderer,
    ...(maxTextureSize !== undefined && {
      max_texture_size: maxTextureSize,
    }),
  });
}

/**
 * Show the full-screen WebGL gate (no GPU-accelerated context). The markup and
 * per-browser fix steps live in the <webgl-gate> Lit component, which is loaded
 * on demand — it's only ever needed in this failure case.
 */
export function showGLGate(status: WebGLGateStatus): void {
  if (document.querySelector("webgl-gate")) {
    return;
  }
  void import("../../components/WebGLGate").then(({ WebGLGate }) => {
    if (document.querySelector("webgl-gate")) {
      return;
    }
    const gate = new WebGLGate();
    gate.status = status;
    document.body.appendChild(gate);
  });
}

/**
 * Backend selection result: either a GPU-accelerated WebGL2 context or a CPU
 * fallback. Unlike {@link initGL} this never throws — a non-accelerated /
 * missing context is reported as `backend: "cpu"` so the caller can fall back
 * to the Canvas2D renderer. `forced` is used when the user opted into CPU
 * rendering via a setting (no GL probing is done in that case).
 */
export type BackendChoice =
  | {
      backend: "gpu";
      gl: WebGL2RenderingContext;
      status: "ok" | "limited";
      renderer: string;
      maxTextureSize?: number;
    }
  | {
      backend: "cpu";
      status: "software" | "unsupported" | "forced";
      renderer: string;
    };

/**
 * Decide between the GPU (WebGL2) and CPU (Canvas2D) renderer backends without
 * throwing. When `forceCpu` is true the GL context is never probed. Otherwise
 * {@link initGL} is run; a `null` gl (software/missing) or a forced CPU path
 * yields `backend: "cpu"`, while an accelerated (ok/limited) context yields
 * `backend: "gpu"`.
 */
export function chooseBackend(
  canvas: HTMLCanvasElement,
  attrs: WebGLContextAttributes = {},
  forceCpu = false,
): BackendChoice {
  if (forceCpu) {
    return { backend: "cpu", status: "forced", renderer: "forced-by-setting" };
  }
  const res = initGL(canvas, attrs);
  if (res.gl === null) {
    return { backend: "cpu", status: res.status, renderer: res.renderer };
  }
  if (res.status === "limited") {
    return {
      backend: "gpu",
      gl: res.gl,
      status: "limited",
      renderer: res.renderer,
      maxTextureSize: res.maxTextureSize,
    };
  }
  return {
    backend: "gpu",
    gl: res.gl,
    status: "ok",
    renderer: readRenderer(res.gl),
  };
}
