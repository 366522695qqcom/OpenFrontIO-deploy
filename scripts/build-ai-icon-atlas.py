#!/usr/bin/env python3
"""
build-ai-icon-atlas.py

Composites the 6 AI-generated (seedream) top-down building icons into the
color atlas used by StructurePass:

  * icon-atlas.png (384x64, 6 columns x 64px) -- structure icons:
      col0=City, col1=Port, col2=Factory, col3=DefensePost,
      col4=SAMLauncher, col5=MissileSilo

The source images live in resources/ai-buildings/ (city.jpg, port.jpg,
factory.jpg, defense_post.jpg, sam_launcher.jpg, missile_silo.jpg) and are
opaque (no alpha) -- the fragment shader clips them with its SDF shape mask,
so no background removal is needed.

Output RGB = the AI image content; alpha = 255 (opaque; shape clipping happens
in the shader). Overwrites resources/atlases/icon-atlas.png, which the build
pipeline re-hashes automatically (see vite.config.ts / PublicAssetManifest).

Dependencies: Pillow.
Idempotent: re-running produces the same output.

Usage:
  python3 frontend/scripts/build-ai-icon-atlas.py
"""

import os
import sys

from PIL import Image

# ---------------------------------------------------------------------------
# Paths (script lives at frontend/scripts/build-ai-icon-atlas.py)
# ---------------------------------------------------------------------------

FRONTEND_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
AI_DIR = os.path.join(FRONTEND_DIR, "resources", "ai-buildings")
ICON_ATLAS_PATH = os.path.join(
    FRONTEND_DIR, "resources", "atlases", "icon-atlas.png"
)

# Atlas column order must match STRUCTURE_ORDER in StructurePass.ts and
# shapeSDF() in structure.frag.glsl.
ICON_ATLAS_COLS = [
    ("city", 0, "City"),
    ("port", 1, "Port"),
    ("factory", 2, "Factory"),
    ("defense_post", 3, "DefensePost"),
    ("sam_launcher", 4, "SAMLauncher"),
    ("missile_silo", 5, "MissileSilo"),
]

ICON_ATLAS_W, ICON_ATLAS_H = 384, 64
ICON_CELL = 64


def load_cell(source, cell_size):
    """Open an AI icon, center-crop to square and downscale to cell_size."""
    im = Image.open(source).convert("RGB")
    w, h = im.size
    side = min(w, h)
    left = (w - side) // 2
    top = (h - side) // 2
    im = im.crop((left, top, left + side, top + side))
    return im.resize((cell_size, cell_size), Image.LANCZOS)


def build_icon_atlas():
    canvas = Image.new("RGBA", (ICON_ATLAS_W, ICON_ATLAS_H), (0, 0, 0, 0))
    for stem, col, _name in ICON_ATLAS_COLS:
        src = os.path.join(AI_DIR, stem + ".jpg")
        if not os.path.exists(src):
            print(f"ERROR: source icon not found: {src}")
            sys.exit(1)
        cell = load_cell(src, ICON_CELL)
        canvas.paste(cell, (col * ICON_CELL, 0))
    canvas.save(ICON_ATLAS_PATH)
    return canvas


def verify(im):
    print("=" * 60)
    print("Verification")
    print("=" * 60)
    print(f"icon-atlas.png  size={im.size[0]}x{im.size[1]}  mode={im.mode}")
    assert im.size == (ICON_ATLAS_W, ICON_ATLAS_H), "icon-atlas size mismatch"

    px = im.load()
    for stem, col, name in ICON_ATLAS_COLS:
        x0, x1 = col * ICON_CELL, (col + 1) * ICON_CELL
        n = 0
        r_sum = g_sum = b_sum = 0
        r_var = g_var = b_var = 0
        for y in range(ICON_ATLAS_H):
            for x in range(x0, x1):
                r, g, b, a = px[x, y]
                if a > 0:
                    n += 1
                    r_sum += r
                    g_sum += g
                    b_sum += b
        if n == 0:
            print(f"  icon col {col} ({name:<12}) EMPTY!")
            sys.exit(1)
        r_avg, g_avg, b_avg = r_sum / n, g_sum / n, b_sum / n
        for y in range(ICON_ATLAS_H):
            for x in range(x0, x1):
                r, g, b, a = px[x, y]
                if a > 0:
                    r_var += (r - r_avg) ** 2
                    g_var += (g - g_avg) ** 2
                    b_var += (b - b_avg) ** 2
        # Combined color stddev: high => clearly colored/detailed content.
        stddev = ((r_var + g_var + b_var) / (n * 3)) ** 0.5
        status = "OK" if stddev > 15 else "LOW COLOR!"
        print(
            f"  icon col {col} ({name:<12}) {n:>5} px  "
            f"avg=({r_avg:3.0f},{g_avg:3.0f},{b_avg:3.0f})  "
            f"stddev={stddev:5.1f}  {status}"
        )
        assert stddev > 15, f"icon col {col} ({name}) looks flat (stddev {stddev})"

    print("\nALL CHECKS PASSED")


def main():
    if not os.path.isdir(AI_DIR):
        print(f"ERROR: expected ai-buildings dir not found: {AI_DIR}")
        sys.exit(1)
    print("Building color icon-atlas.png from AI icons ...")
    im = build_icon_atlas()
    print(f"Saved {ICON_ATLAS_PATH}")
    verify(im)


if __name__ == "__main__":
    main()
