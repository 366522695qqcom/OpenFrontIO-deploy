#!/usr/bin/env python3
"""
build-icon-atlas.py

Rebuilds the two game sprite atlases from the white build-list SVG icons:

  * icon-atlas.png (384x64, 6 columns x 64px) -- structure icons:
      col0=City, col1=Port, col2=Factory, col3=DefensePost,
      col4=SAMLauncher, col5=MissileSilo
  * unit-atlas.png (156x13, 12 columns x 13px) -- only col2 (Warship)
    is replaced by BattleshipIconWhite; every other column is copied
    verbatim from the existing atlas on disk.

Dependencies: cairosvg, Pillow.
Idempotent: re-running produces the same output.

Usage:
  python3 frontend/scripts/build-icon-atlas.py
"""

import io
import os
import sys

import cairosvg
from PIL import Image, ImageOps

# ---------------------------------------------------------------------------
# Paths (script lives at frontend/scripts/build-icon-atlas.py)
# ---------------------------------------------------------------------------

FRONTEND_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
RESOURCES_DIR = os.path.join(FRONTEND_DIR, "resources")
IMAGES_DIR = os.path.join(RESOURCES_DIR, "images")
ATLASES_DIR = os.path.join(RESOURCES_DIR, "atlases")

ICON_ATLAS_PATH = os.path.join(ATLASES_DIR, "icon-atlas.png")
UNIT_ATLAS_PATH = os.path.join(ATLASES_DIR, "unit-atlas.png")

# Structure atlas: (svg stem, column index, display name)
ICON_ATLAS_COLS = [
    ("CityIconWhite", 0, "City"),
    ("PortIcon", 1, "Port"),
    ("FactoryIconWhite", 2, "Factory"),
    ("ShieldIconWhite", 3, "DefensePost"),
    ("SamLauncherIconWhite", 4, "SAMLauncher"),
    ("MissileSiloIconWhite", 5, "MissileSilo"),
]

# Unit atlas: col2 = Warship (11x11 sprite centered in the 13x13 cell).
WARSHIP_SVG = "BattleshipIconWhite"
WARSHIP_COL = 2

ICON_ATLAS_W, ICON_ATLAS_H = 384, 64
ICON_CELL = 64
UNIT_ATLAS_W, UNIT_ATLAS_H = 156, 13
UNIT_CELL = 13
UNIT_COLS = UNIT_ATLAS_W // UNIT_CELL  # 12
WARSHIP_SPRITE = 11  # 11x11, centered -> offset (13-11)/2 = 1

RASTER_CANVAS = 512       # oversize raster before downscale (antialiasing)
ICON_FILL_RATIO = 0.80    # icon body ~80% of the 64px cell (within 60-90%)


# ---------------------------------------------------------------------------
# SVG rasterization helpers
# ---------------------------------------------------------------------------

def rasterize_svg(svg_path, canvas=RASTER_CANVAS):
    """Rasterize an SVG to an RGBA image (transparent background)."""
    png_bytes = cairosvg.svg2png(
        url=svg_path, output_width=canvas, output_height=canvas
    )
    return Image.open(io.BytesIO(png_bytes)).convert("RGBA")


def fit_icon(svg_path, target_extent, canvas=RASTER_CANVAS):
    """Rasterize an SVG and scale the icon body to `target_extent` px.

    Returns (icon, actual_size) where actual_size is (w, h). The icon is
    cropped to its opaque bounding box, preserving aspect ratio. Returns
    (None, None) if the SVG renders blank/fully transparent.
    """
    im = rasterize_svg(svg_path, canvas)
    bbox = im.getchannel("A").getbbox()
    if bbox is None:
        return None, None
    bw, bh = bbox[2] - bbox[0], bbox[3] - bbox[1]
    scale = target_extent / float(max(bw, bh))
    new_w = max(1, int(round(bw * scale)))
    new_h = max(1, int(round(bh * scale)))
    icon = im.crop(bbox).resize((new_w, new_h), Image.LANCZOS)
    return icon, (new_w, new_h)


def to_grayscale_rgba(im):
    """Luminance grayscale of the RGB channels, keeping alpha untouched."""
    gray = ImageOps.grayscale(im)  # L = 0.299R + 0.587G + 0.114B
    return Image.merge("RGBA", (gray, gray, gray, im.getchannel("A")))


def force_white(im):
    """Make every non-transparent pixel white (alpha preserved).

    The structure shader only samples the alpha channel of icon-atlas, so
    forcing white is safe and matches the 'white icon + transparent bg'
    expectation.
    """
    white = Image.new("L", im.size, 255)
    return Image.merge("RGBA", (white, white, white, im.getchannel("A")))


def center_in_cell(icon, cell_size):
    """Copy `icon` centered inside a cell_size x cell_size transparent tile.

    Uses a raw (non-masked) paste so the RGBA values are preserved exactly
    (straight alpha): antialiased edge pixels keep pure-white RGB with their
    true coverage alpha instead of being premultiplied/darkened.
    """
    cell = Image.new("RGBA", (cell_size, cell_size), (0, 0, 0, 0))
    w, h = icon.size
    ox = (cell_size - w) // 2
    oy = (cell_size - h) // 2
    cell.paste(icon, (ox, oy))
    return cell


# ---------------------------------------------------------------------------
# Builders
# ---------------------------------------------------------------------------

def build_icon_atlas():
    """Rebuild icon-atlas.png from the 6 structure SVGs."""
    canvas = Image.new(
        "RGBA", (ICON_ATLAS_W, ICON_ATLAS_H), (0, 0, 0, 0)
    )
    target = ICON_CELL * ICON_FILL_RATIO
    sizes = {}
    for svg_stem, col, name in ICON_ATLAS_COLS:
        svg_path = os.path.join(IMAGES_DIR, svg_stem + ".svg")
        icon, size = fit_icon(svg_path, target)
        if icon is None:
            print(f"ERROR: '{svg_stem}.svg' rasterized to an empty icon")
            sys.exit(1)
        sizes[name] = size
        icon = force_white(icon)
        canvas.paste(center_in_cell(icon, ICON_CELL), (col * ICON_CELL, 0))
    canvas.save(ICON_ATLAS_PATH)
    return sizes


def build_unit_atlas():
    """Rebuild unit-atlas.png, replacing only col2 (Warship)."""
    if not os.path.exists(UNIT_ATLAS_PATH):
        print(f"ERROR: source atlas not found: {UNIT_ATLAS_PATH}")
        sys.exit(1)

    # Snapshot the on-disk atlas; only col2 is modified, everything else is
    # copied verbatim so re-running is idempotent and lossless.
    original = Image.open(UNIT_ATLAS_PATH).convert("RGBA")
    if original.size != (UNIT_ATLAS_W, UNIT_ATLAS_H):
        print(
            f"ERROR: unit-atlas.png has unexpected size {original.size}, "
            f"expected {UNIT_ATLAS_W}x{UNIT_ATLAS_H}"
        )
        sys.exit(1)

    rebuilt = original.copy()

    # Rasterize the battleship, convert to grayscale, resize to 11x11.
    svg_path = os.path.join(IMAGES_DIR, WARSHIP_SVG + ".svg")
    ship = rasterize_svg(svg_path)
    ship = to_grayscale_rgba(ship)
    ship = ship.resize((WARSHIP_SPRITE, WARSHIP_SPRITE), Image.LANCZOS)
    ship_alpha = ship.getchannel("A")
    if ship_alpha.getbbox() is None:
        print(f"ERROR: '{WARSHIP_SVG}.svg' rasterized to an empty icon")
        sys.exit(1)

    # col2 x range is [2*13, 3*13) = [26, 38); 11x11 sprite at offset (1,1).
    # Build the replacement cell on a blank tile, then replace the whole col2
    # cell -- this must fully overwrite the old icon, not composite over it.
    cell_x0 = WARSHIP_COL * UNIT_CELL
    ox = (UNIT_CELL - WARSHIP_SPRITE) // 2
    oy = (UNIT_CELL - WARSHIP_SPRITE) // 2
    cell = Image.new("RGBA", (UNIT_CELL, UNIT_CELL), (0, 0, 0, 0))
    cell.paste(ship, (ox, oy))
    rebuilt.paste(cell, (cell_x0, 0))

    rebuilt.save(UNIT_ATLAS_PATH)
    return original, rebuilt, ship.size


# ---------------------------------------------------------------------------
# Verification
# ---------------------------------------------------------------------------

def opaque_pixel_count(im, col_range, cell_size):
    """Count non-transparent pixels over a column's x-range."""
    px = im.load()
    x0, x1 = col_range
    count = 0
    for y in range(im.height):
        for x in range(x0, x1):
            if px[x, y][3] > 0:
                count += 1
    return count


def verify(icon_sizes, unit_original, unit_rebuilt, ship_size):
    print("=" * 60)
    print("Verification")
    print("=" * 60)

    icon = Image.open(ICON_ATLAS_PATH)
    unit = Image.open(UNIT_ATLAS_PATH)
    print(f"icon-atlas.png  size={icon.size[0]}x{icon.size[1]}  mode={icon.mode}")
    print(f"unit-atlas.png  size={unit.size[0]}x{unit.size[1]}  mode={unit.mode}")
    assert icon.size == (ICON_ATLAS_W, ICON_ATLAS_H), "icon-atlas size mismatch"
    assert unit.size == (UNIT_ATLAS_W, UNIT_ATLAS_H), "unit-atlas size mismatch"

    print("\nRasterized icon sizes (after scaling):")
    for name, (w, h) in icon_sizes.items():
        print(f"  {name:<12} {w}x{h}")

    print("\nOpaque pixel counts:")
    for svg_stem, col, name in ICON_ATLAS_COLS:
        cnt = opaque_pixel_count(icon, (col * ICON_CELL, (col + 1) * ICON_CELL),
                                 ICON_CELL)
        status = "OK" if cnt > 0 else "EMPTY!"
        print(f"  icon col {col} ({name:<12}) {cnt:>5} px  {status}")
        assert cnt > 0, f"icon col {col} ({name}) is empty"
    unit_col2 = opaque_pixel_count(unit, (WARSHIP_COL * UNIT_CELL,
                                          (WARSHIP_COL + 1) * UNIT_CELL),
                                   UNIT_CELL)
    status = "OK" if unit_col2 > 0 else "EMPTY!"
    print(f"  unit col {WARSHIP_COL} (Warship)        {unit_col2:>5} px  {status}")
    assert unit_col2 > 0, "unit col2 (Warship) is empty"

    # Only col2 may differ in unit-atlas. Compare all other columns
    # pixel-by-pixel against the pre-modification snapshot.
    diff_cols = []
    u0 = unit_original.convert("RGBA")
    u1 = unit_rebuilt.convert("RGBA")
    for c in range(UNIT_COLS):
        if c == WARSHIP_COL:
            continue
        x0, x1 = c * UNIT_CELL, (c + 1) * UNIT_CELL
        same = True
        for y in range(UNIT_ATLAS_H):
            for x in range(x0, x1):
                if u0.getpixel((x, y)) != u1.getpixel((x, y)):
                    same = False
                    break
            if not same:
                break
        if not same:
            diff_cols.append(c)

    if diff_cols:
        print(
            f"\nFAIL: unit-atlas columns changed besides col2: {diff_cols}"
        )
        sys.exit(1)
    unchanged = ", ".join(str(c) for c in range(UNIT_COLS) if c != WARSHIP_COL)
    print(
        f"\nunit-atlas columns {unchanged} identical before/after "
        f"(only col2 replaced)  OK"
    )
    print(f"unit col2 Warship sprite size: {ship_size[0]}x{ship_size[1]}")
    print("\nALL CHECKS PASSED")


# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------

def main():
    if not os.path.isdir(ATLASES_DIR) or not os.path.isdir(IMAGES_DIR):
        print(f"ERROR: expected resource dirs not found under {RESOURCES_DIR}")
        sys.exit(1)

    print("Building icon-atlas.png ...")
    icon_sizes = build_icon_atlas()
    print("Building unit-atlas.png ...")
    unit_original, unit_rebuilt, ship_size = build_unit_atlas()

    print("\nRebuild done. Verifying ...")
    verify(icon_sizes, unit_original, unit_rebuilt, ship_size)


if __name__ == "__main__":
    main()
