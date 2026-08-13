import {
  EffectsPolicy,
  SKIPPED_EFFECTS,
} from "../../../../src/client/render/canvas/EffectsPolicy";
import { createRenderSettings } from "../../../../src/client/render/gl/RenderSettings";

// The full set of GPU-only effect names the CPU path skips (11 total).
const SKIPPED_NAMES = [
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
] as const;

describe("SKIPPED_EFFECTS", () => {
  it("contains all 11 GPU-only effect names", () => {
    expect(SKIPPED_EFFECTS.size).toBe(11);
    for (const name of SKIPPED_NAMES) {
      expect(SKIPPED_EFFECTS.has(name)).toBe(true);
    }
  });
});

describe("EffectsPolicy", () => {
  it("disables skipped effects and enables everything else", () => {
    const policy = new EffectsPolicy(createRenderSettings());

    // A representative skipped GPU effect.
    expect(policy.isEffectEnabled("falloutBloom")).toBe(false);
    // terrain is not in the skipped set, so it stays enabled.
    expect(policy.isEffectEnabled("terrain")).toBe(true);
  });

  it("applyFalloutTint moves RGB toward the tint and preserves alpha", () => {
    const policy = new EffectsPolicy(createRenderSettings());
    const rgba: [number, number, number, number] = [100, 100, 100, 255];

    policy.applyFalloutTint(rgba);

    // Alpha is intentionally left unchanged.
    expect(rgba[3]).toBe(255);
    // RGB moved away from the original [100, 100, 100] toward the tint.
    expect([rgba[0], rgba[1], rgba[2]]).not.toEqual([100, 100, 100]);
  });
});
