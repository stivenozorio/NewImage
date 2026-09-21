# -*- coding: utf-8 -*-
"""Renders the home page's service tiles from the gallery originals.

    python3 tools/build-card-images.py

The tiles are at most ~610 CSS px wide, so shipping the 1600px gallery
files to fill them would cost about a megabyte for pixels nobody sees.
Each tile gets a crop at roughly the size and shape it is displayed at,
doubled for high-density screens.

Needs ffmpeg on PATH (or FFMPEG=/path/to/ffmpeg).
"""
import os
import pathlib
import shutil
import subprocess
import sys

ROOT = pathlib.Path(__file__).resolve().parent.parent
OUT = ROOT / "assets/images/cards"
FFMPEG = os.environ.get("FFMPEG") or shutil.which("ffmpeg")

# slug -> (gallery file, width, height)
# The three shapes match the mosaic: a 2x2 feature, 1x1 tiles and 2x1 bands.
TILES = {
    "kitchen":           ("kitchens/kitchen-02.webp",      1200, 1000),
    "bathroom":          ("bathrooms/bathroom-02.webp",     700,  600),
    "closets":           ("closets/closet-05.webp",         700,  600),
    "floor":             ("floors/floor-01.webp",           700,  600),
    "exterior-work":     ("exterior/exterior-06.webp",     1200,  540),
    "custom-wall-units": ("wall-units/wall-unit-02.webp",  1200,  540),
    # painting has no photography in the repo; its tile is drawn in CSS.
}

if not FFMPEG:
    sys.exit("ffmpeg no encontrado: instalalo o exporta FFMPEG=/ruta/a/ffmpeg")

OUT.mkdir(parents=True, exist_ok=True)
for slug, (src, w, h) in TILES.items():
    source = ROOT / "assets/images/gallery" / src
    if not source.exists():
        sys.exit(f"falta el original: {source}")
    dest = OUT / f"{slug}.webp"
    subprocess.run([
        FFMPEG, "-v", "error", "-y", "-i", str(source),
        "-vf", f"scale={w}:{h}:force_original_aspect_ratio=increase:flags=lanczos,crop={w}:{h}",
        "-c:v", "libwebp", "-quality", "80", "-compression_level", "6",
        str(dest),
    ], check=True)
    print(f"  {dest.relative_to(ROOT)}  {w}x{h}  {dest.stat().st_size // 1024} KB")

total = sum(f.stat().st_size for f in OUT.glob("*.webp"))
print(f"{len(TILES)} tiles, {total // 1024} KB en total")
