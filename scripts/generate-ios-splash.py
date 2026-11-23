#!/usr/bin/env python3
"""Generate portrait iOS PWA splash images for Magic City Nights.

Solid #0B1426 background with images/logo-simple.webp centered.
Phone logo width ~58% (height capped at 38%); iPad logo width ~42%
(height capped at 32%). Output: icons/splash/apple-splash-{w}x{h}.png
"""
from __future__ import annotations

import subprocess
import sys
from pathlib import Path

from PIL import Image

NAVY = (0x0B, 0x14, 0x26)

# CSS device-width, device-height, pixel ratio, pixel W, pixel H, devices.
# From pwa-asset-generator 8.1.7 (Sept 2026) plus Houston's listed sizes.
# Landscape variants are intentionally omitted (phone-first app).
TARGETS = [
    (440, 956, 3, 1320, 2868, "iPhone 17 Pro Max, 16 Pro Max"),
    (420, 912, 3, 1260, 2736, "iPhone Air"),
    (402, 874, 3, 1206, 2622, "iPhone 17 Pro, 17, 16 Pro"),
    (430, 932, 3, 1290, 2796, "iPhone 16 Plus, 15 Pro Max, 15 Plus, 14 Pro Max"),
    (393, 852, 3, 1179, 2556, "iPhone 16, 15 Pro, 15, 14 Pro"),
    (428, 926, 3, 1284, 2778, "iPhone 14 Plus, 13 Pro Max, 12 Pro Max"),
    (390, 844, 3, 1170, 2532, "iPhone 16e, 14, 13 Pro, 13, 12 Pro, 12"),
    (375, 812, 3, 1125, 2436, "iPhone 11 Pro, XS, X"),
    (360, 780, 3, 1080, 2340, "iPhone 13 mini, 12 mini"),
    (414, 896, 3, 1242, 2688, "iPhone 11 Pro Max, XS Max"),
    (414, 896, 2, 828, 1792, "iPhone 11, XR"),
    (414, 736, 3, 1242, 2208, "iPhone 8 Plus, 7 Plus, 6s Plus, 6 Plus"),
    (375, 667, 2, 750, 1334, "iPhone SE (2nd/3rd), 8, 7, 6s, 6"),
    (320, 568, 2, 640, 1136, "iPhone SE (1st generation)"),
    (1032, 1376, 2, 2064, 2752, "iPad Pro 13-inch"),
    (1024, 1366, 2, 2048, 2732, "iPad Pro 12.9-inch, iPad Air 13-inch"),
    (834, 1210, 2, 1668, 2420, "iPad Pro 11-inch (5th and 6th generation)"),
    (834, 1194, 2, 1668, 2388, "iPad Pro 11-inch (1st-4th generation)"),
    (820, 1180, 2, 1640, 2360, "iPad Air 11-inch and 10.9-inch, iPad 11-inch"),
    (834, 1112, 2, 1668, 2224, "iPad Pro 10.5-inch, iPad Air 10.5-inch"),
    (810, 1080, 2, 1620, 2160, "iPad 10.2-inch"),
    (744, 1133, 2, 1488, 2266, "iPad mini 8.3-inch"),
    (768, 1024, 2, 1536, 2048, "iPad Pro/Air 9.7-inch, iPad 9.7-inch, iPad mini 7.9-inch"),
]


def logo_dims(cw: int, ch: int, lw: int, lh: int) -> tuple[int, int]:
    is_tablet = cw >= 1488
    width_frac = 0.42 if is_tablet else 0.58
    height_frac = 0.32 if is_tablet else 0.38
    target_w = cw * width_frac
    target_h = target_w * (lh / lw)
    max_h = ch * height_frac
    if target_h > max_h:
        target_h = max_h
        target_w = target_h * (lw / lh)
    return max(1, int(round(target_w))), max(1, int(round(target_h)))


def main() -> int:
    root = Path(__file__).resolve().parent.parent
    logo_path = root / "images" / "logo-simple.webp"
    out_dir = root / "icons" / "splash"
    if not logo_path.is_file():
        print(f"missing logo: {logo_path}", file=sys.stderr)
        return 1
    out_dir.mkdir(parents=True, exist_ok=True)

    logo = Image.open(logo_path).convert("RGBA")
    lw, lh = logo.size
    results = []
    for css_w, css_h, dpr, pw, ph, devices in TARGETS:
        if pw != css_w * dpr or ph != css_h * dpr:
            raise SystemExit(f"size mismatch: {css_w}x{css_h} @{dpr} != {pw}x{ph}")
        canvas = Image.new("RGB", (pw, ph), NAVY)
        tw, th = logo_dims(pw, ph, lw, lh)
        resized = logo.resize((tw, th), Image.Resampling.LANCZOS)
        x = (pw - tw) // 2
        y = (ph - th) // 2
        if x < 0 or y < 0 or x + tw > pw or y + th > ph:
            raise SystemExit(f"logo clipped on {pw}x{ph}")
        canvas.paste(resized, (x, y), resized)
        if canvas.getpixel((0, 0)) != NAVY or canvas.getpixel((pw - 1, ph - 1)) != NAVY:
            raise SystemExit(f"navy seam on {pw}x{ph}")
        path = out_dir / f"apple-splash-{pw}x{ph}.png"
        canvas.save(path, "PNG", optimize=True, compress_level=9)
        results.append({"path": path, "w": pw, "h": ph, "devices": devices})
        print(f"wrote {path.name} ({pw}x{ph}) for {devices}")

    # Lossless recompress when optipng is available.
    try:
        subprocess.run(
            ["optipng", "-o5", "-quiet", *[str(r["path"]) for r in results]],
            check=True,
        )
        print("optipng ok")
    except FileNotFoundError:
        print("optipng not found; left Pillow output as-is")
    except subprocess.CalledProcessError as exc:
        print(f"optipng failed ({exc.returncode}); left Pillow output as-is")

    for r in results:
        data = r["path"].read_bytes()
        if data[:8] != b"\x89PNG\r\n\x1a\n":
            raise SystemExit(f"invalid PNG signature: {r['path']}")
        print(f"{r['path'].name}: {len(data)} bytes")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
