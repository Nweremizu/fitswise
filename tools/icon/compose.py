"""python tools/icon/compose.py BUD.png OUT.png [SHEET.png]

Puts the rendered earbud (tools/icon/bud.py) on the app tile, at 1024 px. With SHEET, also shows the
icon at the sizes Windows uses, on light and dark backgrounds.

Then: pnpm tauri icon OUT.png
"""
import sys

import numpy as np
from PIL import Image, ImageChops, ImageDraw, ImageFilter

N, K = 1024, 4  # output size and supersampling
S = N * K
MARGIN = 0.055  # empty border, as a share of the size
FILL = 0.64  # longest side of the bud, as a share of the tile


def squircle(size, inset, n=4.2):
    """Mask of a superellipse: continuous corners, like Apple and Fluent tiles."""
    y, x = np.mgrid[0:size, 0:size].astype(np.float32)
    r = size / 2 - inset
    d = (np.abs((x - size / 2 + 0.5) / r) ** n + np.abs((y - size / 2 + 0.5) / r) ** n)
    return Image.fromarray(((d <= 1) * 255).astype(np.uint8))


def gradient(size, top, bottom):
    t = np.linspace(0, 1, size, dtype=np.float32)[:, None, None]
    c = np.array(top, np.float32) * (1 - t) + np.array(bottom, np.float32) * t
    return Image.fromarray(np.broadcast_to(c, (size, size, 3)).astype(np.uint8))


def glow(size, cx, cy, radius, color, alpha):
    y, x = np.mgrid[0:size, 0:size].astype(np.float32)
    d = np.hypot(x - cx * size, y - cy * size) / (radius * size)
    a = np.clip(1 - d, 0, 1) ** 2 * alpha * 255
    img = np.zeros((size, size, 4), np.uint8)
    img[..., :3], img[..., 3] = color, a.astype(np.uint8)
    return Image.fromarray(img)


def tile():
    inset = MARGIN * S
    mask = squircle(S, inset)
    base = gradient(S, (48, 66, 78), (10, 15, 19)).convert("RGBA")
    base.alpha_composite(glow(S, 0.5, 0.44, 0.72, (128, 200, 224), 0.62))
    # quiet rings behind the bud: noise control, without spelling it out
    rings = Image.new("RGBA", (S, S))
    d = ImageDraw.Draw(rings)
    cx, cy = S * 0.5, S * 0.5
    for r, a in ((0.25, 44), (0.33, 28), (0.41, 15)):
        rr = r * S
        d.ellipse([cx - rr, cy - rr, cx + rr, cy + rr], outline=(200, 236, 248, a), width=int(0.006 * S))
    base.alpha_composite(rings)
    # light catching the top edge, darkness pooling at the bottom
    edge = ImageChops.subtract(mask, mask.filter(ImageFilter.MinFilter(9)))
    top = gradient(S, (255, 255, 255), (0, 0, 0)).convert("L")
    rim = Image.new("RGBA", (S, S), (255, 255, 255, 0))
    rim.putalpha(ImageChops.multiply(edge, top.point(lambda v: v * 0.22)))
    base.alpha_composite(rim)
    out = Image.new("RGBA", (S, S))
    out.paste(base, mask=mask)
    return out, mask


def place(bud, mask):
    bud = bud.crop(bud.getbbox())
    k = FILL * (1 - 2 * MARGIN) * S / max(bud.size)
    bud = bud.resize((int(bud.width * k), int(bud.height * k)), Image.LANCZOS)
    x, y = (S - bud.width) // 2, (S - bud.height) // 2 + int(0.01 * S)
    layer = Image.new("RGBA", (S, S))
    # soft shadow under the bud, kept inside the tile
    shade = Image.new("L", (S, S))
    shade.paste(bud.getchannel("A"), (x, y + int(0.035 * S)))
    shade = shade.filter(ImageFilter.GaussianBlur(0.035 * S)).point(lambda v: v * 0.7)
    layer.paste((4, 10, 14, 255), mask=ImageChops.multiply(shade, mask))
    layer.alpha_composite(bud, (x, y))
    return layer


def main():
    bud = Image.open(sys.argv[1]).convert("RGBA")
    bud = bud.resize((bud.width * K // 2, bud.height * K // 2), Image.LANCZOS) if bud.width < S // 2 else bud
    icon, mask = tile()
    icon.alpha_composite(place(bud, mask))
    icon = icon.resize((N, N), Image.LANCZOS)
    icon.save(sys.argv[2])
    if len(sys.argv) > 3:
        sizes = [16, 20, 24, 32, 48, 64, 128, 256]
        sheet = Image.new("RGBA", (sum(s + 28 for s in sizes) + 28, 600))
        d = ImageDraw.Draw(sheet)
        for row, bg in enumerate(("#f3f3f3", "#1f1f1f")):
            d.rectangle([0, row * 300, sheet.width, row * 300 + 300], fill=bg)
            x = 28
            for s in sizes:
                sheet.alpha_composite(icon.resize((s, s), Image.LANCZOS), (x, row * 300 + 150 - s // 2))
                x += s + 28
        sheet.save(sys.argv[3])


main()
