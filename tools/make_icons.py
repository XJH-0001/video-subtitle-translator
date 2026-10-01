"""
生成扩展图标（16 / 32 / 48 / 128 px）。

    python tools/make_icons.py

设计：蓝色圆角方块 + 两条白色字幕条。
16px 下还能看出是「字幕」，比塞一个汉字清楚得多。
"""

from __future__ import annotations

from pathlib import Path

from PIL import Image, ImageDraw

ROOT = Path(__file__).resolve().parent.parent
OUT = ROOT / "extension" / "icons"
SIZE = 512


def lerp(a: tuple[int, int, int], b: tuple[int, int, int], t: float) -> tuple[int, int, int]:
    return tuple(round(a[i] + (b[i] - a[i]) * t) for i in range(3))  # type: ignore[return-value]


def make_master() -> Image.Image:
    img = Image.new("RGBA", (SIZE, SIZE), (0, 0, 0, 0))

    # 竖向渐变（用 1px 宽的渐变条拉伸，比逐像素画快）
    top = (76, 141, 255)
    bottom = (28, 78, 216)
    grad = Image.new("RGB", (1, SIZE))
    gd = ImageDraw.Draw(grad)
    for y in range(SIZE):
        gd.point((0, y), fill=lerp(top, bottom, y / (SIZE - 1)))
    grad = grad.resize((SIZE, SIZE))

    # 圆角遮罩
    mask = Image.new("L", (SIZE, SIZE), 0)
    ImageDraw.Draw(mask).rounded_rectangle([0, 0, SIZE - 1, SIZE - 1], radius=int(SIZE * 0.22), fill=255)

    img.paste(grad, (0, 0), mask)

    # 斜向高光：必须画在独立图层上再 alpha_composite，
    # 直接 draw.ellipse 带 alpha 是「替换」而不是「混合」，会留下一块灰白。
    glow = Image.new("RGBA", (SIZE, SIZE), (0, 0, 0, 0))
    ImageDraw.Draw(glow).ellipse(
        [-SIZE * 0.35, -SIZE * 0.85, SIZE * 1.35, SIZE * 0.30], fill=(255, 255, 255, 30)
    )
    glow = Image.composite(Image.new("RGBA", (SIZE, SIZE), (255, 255, 255, 0)), glow, mask)
    img = Image.alpha_composite(img, glow)
    d = ImageDraw.Draw(img)

    # 字幕底衬
    strip_top = int(SIZE * 0.545)
    strip_bottom = int(SIZE * 0.845)
    d.rounded_rectangle(
        [SIZE * 0.11, strip_top, SIZE * 0.89, strip_bottom],
        radius=int(SIZE * 0.075),
        fill=(9, 14, 26, 150),
    )

    # 两条字幕条
    bar_h = int(SIZE * 0.075)
    r = bar_h // 2
    y1 = int(strip_top + SIZE * 0.052)
    y2 = int(y1 + bar_h + SIZE * 0.045)
    d.rounded_rectangle([SIZE * 0.19, y1, SIZE * 0.81, y1 + bar_h], radius=r, fill=(255, 255, 255, 255))
    d.rounded_rectangle([SIZE * 0.19, y2, SIZE * 0.66, y2 + bar_h], radius=r, fill=(255, 255, 255, 205))

    return img


def main() -> None:
    OUT.mkdir(parents=True, exist_ok=True)
    master = make_master()
    for size in (16, 32, 48, 128):
        icon = master.resize((size, size), Image.LANCZOS)
        path = OUT / f"icon{size}.png"
        icon.save(path, "PNG")
        print(f"  {path.relative_to(ROOT)}  {path.stat().st_size} bytes")


if __name__ == "__main__":
    main()
