"""生成插件图标：圆角蓝底 + 白色书签造型。需 Pillow。"""
from PIL import Image, ImageDraw

BRAND = (91, 141, 239)       # #5B8DEF
BRAND_DARK = (59, 91, 219)   # #3B5BDB
WHITE = (255, 255, 255)


def rounded_rect(draw, box, radius, fill):
    draw.rounded_rectangle(box, radius=radius, fill=fill)


def make_icon(size):
    img = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    d = ImageDraw.Draw(img)
    m = max(1, size // 16)
    # 背景圆角方块（带轻微渐变感：上层亮色覆盖）
    rounded_rect(d, [m, m, size - m, size - m], size // 5, BRAND_DARK)
    rounded_rect(d, [m, m, size - m, size - m - max(1, size // 12)], size // 5, BRAND)

    # 白色书签：顶部齐平、底部 V 形缺口
    pad = size * 0.26
    bw = size - pad * 2
    bh = size - pad * 1.7
    bx0, by0 = pad, pad * 0.7
    bx1 = bx0 + bw
    by1 = by0 + bh
    notch = bw * 0.28
    d.polygon(
        [
            (bx0, by0),
            (bx1, by0),
            (bx1, by1),
            ((bx0 + bx1) / 2, by1 - notch),
            (bx0, by1),
        ],
        fill=WHITE,
    )
    # 底部挖空形成书签镂空效果（用背景色覆盖下半部分中部）
    hole_h = bh * 0.22
    d.rectangle(
        [bx0 + bw * 0.28, by0 + bh * 0.42, bx1 - bw * 0.28, by0 + bh * 0.42 + hole_h],
        fill=BRAND,
    )
    return img


if __name__ == "__main__":
    for s in (16, 48, 128):
        make_icon(s).save(f"icons/icon{s}.png")
    print("icons generated")
