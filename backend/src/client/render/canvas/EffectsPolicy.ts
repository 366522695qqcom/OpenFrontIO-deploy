import type { RenderSettings } from "../gl/RenderSettings";

/**
 * GPU-only effect pass names that the CPU (CanvasRenderer) path skips.
 *
 * CanvasRenderer never invokes these passes, so "skipping" is automatic —
 * this set exists to make the graceful-degradation policy explicit and
 * discoverable (queried via {@link EffectsPolicy.isEffectEnabled}).
 */
export const SKIPPED_EFFECTS: ReadonlySet<string> = new Set([
  "falloutBloom",
  "smallPlayerGlow",
  "nightComposite",
  "lightmap",
  "pointLight",
  "falloutLight",
  "fxShockwave",
  "fxAttackRing",
  "fxSprite",
  "spiralRibbon",
  "heatManager",
]);

/** Static fallback tint (0-255 RGB) when bloom settings are zero/missing. */
const FALLBACK_TINT: readonly [number, number, number] = [40, 80, 30];

/** Mix ratio of the fallout tint into the existing pixel color (0..1). */
const FALLOUT_TINT_RATIO = 0.5;

/**
 * Centralizes the CPU render path's GPU-effect graceful-degradation policy.
 *
 * The CanvasRenderer does not invoke any GPU render passes; this class makes
 * that skip set explicit (see {@link SKIPPED_EFFECTS}) and provides the static
 * fallout tile tint used by territory fill as a substitute for the animated
 * FalloutBloomPass.
 */
export class EffectsPolicy {
  private readonly settings: RenderSettings;
  /** Precomputed fallout tint target color, 0-255 RGB. */
  private readonly falloutTint: readonly [number, number, number];

  constructor(settings: RenderSettings) {
    this.settings = settings;
    this.falloutTint = EffectsPolicy.computeFalloutTint(settings);
  }

  private static computeFalloutTint(
    settings: RenderSettings,
  ): readonly [number, number, number] {
    const fb = settings.falloutBloom;
    const r = fb.bloomR;
    const g = fb.bloomG;
    const b = fb.bloomB;
    if (!r && !g && !b) {
      return FALLBACK_TINT;
    }
    return [Math.round(r * 255), Math.round(g * 255), Math.round(b * 255)];
  }

  /**
   * Returns false for all GPU-only effect passes on the CPU path. Effect names
   * not listed in {@link SKIPPED_EFFECTS} are treated as enabled.
   */
  isEffectEnabled(name: string): boolean {
    return !SKIPPED_EFFECTS.has(name);
  }

  /**
   * Mutates an RGBA array (0-255 ints) in-place, mixing the existing RGB
   * toward the static fallout tint at ~50%. Alpha is left unchanged. This is
   * the CPU path's static substitute for the animated FalloutBloomPass.
   */
  applyFalloutTint(rgba: [number, number, number, number]): void {
    const tint = this.falloutTint;
    const keep = 1 - FALLOUT_TINT_RATIO;
    rgba[0] = Math.round(rgba[0] * keep + tint[0] * FALLOUT_TINT_RATIO);
    rgba[1] = Math.round(rgba[1] * keep + tint[1] * FALLOUT_TINT_RATIO);
    rgba[2] = Math.round(rgba[2] * keep + tint[2] * FALLOUT_TINT_RATIO);
    // rgba[3] (alpha) intentionally left unchanged.
  }
}
