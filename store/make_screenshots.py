# -*- coding: utf-8 -*-
"""
生成 Chrome Web Store 商店截图。

用途：产出 3 张 1280x800 的商店截图，RGB 模式（无 alpha 通道，符合商店要求）。
运行：python store/make_screenshots.py
输出：store/screenshot-1-main.png / screenshot-2-result.png / screenshot-3-flow.png

说明：图中界面按 popup.css 的真实配色与结构还原，非设计稿。
"""
import os
from PIL import Image, ImageDraw, ImageFont, ImageFilter

W, H = 1280, 800
HERE = os.path.dirname(os.path.abspath(__file__))

FONT_REG = "C:/Windows/Fonts/msyh.ttc"
FONT_BLD = "C:/Windows/Fonts/msyhbd.ttc"

# 与 popup.css / options.css 一致的配色
C_BG1 = (11, 18, 32)
C_BG2 = (21, 33, 56)
C_BG = (15, 23, 42)          # --bg
C_PANEL = (30, 41, 59)       # --panel
C_PANEL2 = (39, 52, 73)      # --panel2
C_TEXT = (226, 232, 240)     # --text
C_MUTED = (148, 163, 184)    # --muted
C_ACCENT = (91, 141, 239)    # --accent
C_ACCENT_D = (59, 91, 219)
C_WARN = (245, 158, 11)
C_OK = (34, 197, 94)
C_DANGER = (185, 28, 28)
C_LINE = (51, 65, 85)

_font_cache = {}


def F(size, bold=False):
    key = (size, bold)
    if key not in _font_cache:
        _font_cache[key] = ImageFont.truetype(FONT_BLD if bold else FONT_REG, size)
    return _font_cache[key]


def vgrad(w, h, c1, c2):
    g = Image.new("RGB", (w, h))
    d = ImageDraw.Draw(g)
    for y in range(h):
        t = y / max(1, h - 1)
        d.line([(0, y), (w, y)], fill=tuple(int(c1[i] + (c2[i] - c1[i]) * t) for i in range(3)))
    return g


def hgrad(w, h, c1, c2):
    g = Image.new("RGB", (w, h))
    d = ImageDraw.Draw(g)
    for x in range(w):
        t = x / max(1, w - 1)
        d.line([(x, 0), (x, h)], fill=tuple(int(c1[i] + (c2[i] - c1[i]) * t) for i in range(3)))
    return g


def add_shadow(img, box, radius=18, blur=22, offset=(0, 12), alpha=130):
    """在 RGBA 图上给圆角矩形加柔和投影。"""
    x0, y0, x1, y1 = box
    sh = Image.new("RGBA", img.size, (0, 0, 0, 0))
    ImageDraw.Draw(sh).rounded_rectangle(
        [x0 + offset[0], y0 + offset[1], x1 + offset[0], y1 + offset[1]],
        radius=radius, fill=(0, 0, 0, alpha),
    )
    sh = sh.filter(ImageFilter.GaussianBlur(blur))
    return Image.alpha_composite(img, sh)


def top_rounded_gradient(w, h, radius, c1, c2):
    """生成只有上方两角为圆角的横向渐变块（返回 RGBA）。"""
    g = hgrad(w, h, c1, c2).convert("RGBA")
    m = Image.new("L", (w, h), 0)
    ImageDraw.Draw(m).rounded_rectangle([0, 0, w - 1, h + radius], radius=radius, fill=255)
    g.putalpha(m)
    return g


def bookmark_glyph(d, x, y, w, h, fill):
    """书签形状图标。"""
    notch = w * 0.34
    d.polygon(
        [(x, y), (x + w, y), (x + w, y + h), (x + w / 2, y + h - notch), (x, y + h)],
        fill=fill,
    )


def folder_glyph(d, x, y, w, h, fill):
    """文件夹形状图标。"""
    tab = w * 0.42
    d.rounded_rectangle([x, y, x + tab, y + h * 0.26], radius=2, fill=fill)
    d.rounded_rectangle([x, y + h * 0.12, x + w, y + h], radius=3, fill=fill)


def draw_soft_dot(d, cx, cy, r, color):
    d.ellipse([cx - r, cy - r, cx + r, cy + r], fill=color)


# ---------------------------------------------------------------- 场景 1：主界面
def scene_main():
    img = vgrad(W, H, C_BG1, C_BG2).convert("RGBA")

    # 背景光晕
    glow = Image.new("RGBA", (W, H), (0, 0, 0, 0))
    ImageDraw.Draw(glow).ellipse([620, -80, 1560, 620], fill=(59, 91, 219, 46))
    img = Image.alpha_composite(img, glow.filter(ImageFilter.GaussianBlur(120)))

    px, py, pw, ph = 92, 84, 404, 632
    img = add_shadow(img, [px, py, px + pw, py + ph], radius=18)
    d = ImageDraw.Draw(img)

    # 面板底
    d.rounded_rectangle([px, py, px + pw, py + ph], radius=18, fill=C_BG, outline=C_LINE, width=1)

    # 顶部渐变头
    hh = 58
    head = top_rounded_gradient(pw - 2, hh, 17, C_ACCENT_D, C_ACCENT)
    img.paste(head, (px + 1, py + 1), head)
    d = ImageDraw.Draw(img)
    bookmark_glyph(d, px + 20, py + 19, 15, 20, (255, 255, 255))
    d.text((px + 44, py + 29), "书签智能整理", font=F(17, True), fill=(255, 255, 255), anchor="lm")
    d.rounded_rectangle([px + pw - 44, py + 15, px + pw - 16, py + 43], radius=9, fill=(104, 138, 233))
    for i in range(3):
        draw_soft_dot(d, px + pw - 30 + (i - 1) * 6, py + 29, 2, (255, 255, 255))

    # 统计三卡
    cy = py + hh + 16
    cw = (pw - 28 - 16) / 3
    for i, (num, lbl, col) in enumerate(
        [("316", "书签总数", C_TEXT), ("42", "文件夹", C_TEXT), ("18", "重复书签", C_WARN)]
    ):
        cx = px + 14 + i * (cw + 8)
        d.rounded_rectangle([cx, cy, cx + cw, cy + 68], radius=11, fill=C_PANEL)
        d.text((cx + cw / 2, cy + 26), num, font=F(24, True), fill=col, anchor="mm")
        d.text((cx + cw / 2, cy + 51), lbl, font=F(12), fill=C_MUTED, anchor="mm")

    # 分类分布
    by = cy + 84
    cats = [
        ("开发技术", "#3b82f6", 96, C_ACCENT),
        ("工具效率", "#64748b", 64, (100, 116, 139)),
        ("学习教育", "#10b981", 48, (16, 185, 129)),
        ("新闻资讯", "#f59e0b", 41, C_WARN),
        ("影音娱乐", "#8b5cf6", 33, (139, 92, 246)),
        ("金融财经", "#0ea5e9", 22, (14, 165, 233)),
        ("其他", "#94a3b8", 12, C_MUTED),
    ]
    maxn = max(c[2] for c in cats)
    for i, (name, _hex, n, col) in enumerate(cats):
        ry = by + i * 23
        draw_soft_dot(d, px + 20, ry + 7, 4.5, col)
        d.text((px + 32, ry + 7), name, font=F(13), fill=C_TEXT, anchor="lm")
        d.rounded_rectangle([px + 150, ry + 4, px + 320, ry + 11], radius=4, fill=C_PANEL2)
        d.rounded_rectangle([px + 150, ry + 4, px + 150 + 170 * (n / maxn), ry + 11], radius=4, fill=col)
        d.text((px + pw - 16, ry + 7), str(n), font=F(13), fill=C_MUTED, anchor="rm")

    # 按钮
    ay = by + len(cats) * 23 + 12
    bw = (pw - 28 - 16) / 3
    for i, (txt, bg, fg) in enumerate(
        [("扫描并分类", C_ACCENT, (255, 255, 255)), ("生成预览", C_ACCENT, (255, 255, 255)), ("执行整理", C_DANGER, (255, 255, 255))]
    ):
        bx = px + 14 + i * (bw + 8)
        d.rounded_rectangle([bx, ay, bx + bw, ay + 38], radius=10, fill=bg)
        d.text((bx + bw / 2, ay + 19), txt, font=F(14, True), fill=fg, anchor="mm")

    # 进度条（多阶段加权：筛选 18~30%、复制 30~75%，228/316 落在 30+45*0.72≈63%）
    gy = ay + 52
    d.rounded_rectangle([px + 14, gy, px + pw - 14, gy + 8], radius=5, fill=C_PANEL2)
    d.rounded_rectangle([px + 14, gy, px + 14 + (pw - 28) * 0.63, gy + 8], radius=5, fill=C_ACCENT)
    d.text((px + 14, gy + 18), "生成预览中… 228/316（已复制 187）", font=F(12), fill=C_MUTED, anchor="lm")
    d.text((px + pw - 14, gy + 18), "63%", font=F(12), fill=C_MUTED, anchor="rm")

    # 日志
    ly = gy + 36
    d.rounded_rectangle([px + 14, ly, px + pw - 14, ly + 92], radius=10, fill=C_PANEL)
    logs = [
        ("扫描完成，共 316 个书签，重复 18 个。", C_MUTED),
        ("书签未变化，复用上次分类结果（本次未调用 AI）", C_MUTED),
        ("已跳过根目录书签 7 个（按设置保持原位）", C_MUTED),
        ("二级细分：每分类最多 5 个子文件夹，书签少于 10 个的分类不细分。", C_MUTED),
        ("预览已生成：共复制 288 个书签。", C_OK),
    ]
    for i, (t, c) in enumerate(logs):
        d.text((px + 26, ly + 14 + i * 16), t, font=F(11), fill=c, anchor="lm")

    # 右侧文案
    tx = 560
    d.text((tx, 210), "AI 自动分类", font=F(46, True), fill=C_TEXT)
    d.text((tx, 268), "书签一眼清晰", font=F(46, True), fill=C_ACCENT)
    d.text((tx, 344), "把散落几百条的书签，按主题重新组织成", font=F(17), fill=C_MUTED)
    d.text((tx, 372), "结构化目录。支持 AI 与离线关键词两种模式。", font=F(17), fill=C_MUTED)

    feats = [
        "11 类主题自动归类，分类与关键词可自定义",
        "重复书签自动检测，按你确认决定是否清理",
        "放在书签栏根目录的书签默认保持原位，方便点击",
    ]
    for i, t in enumerate(feats):
        yy = 436 + i * 42
        d.rounded_rectangle([tx, yy + 6, tx + 10, yy + 16], radius=2, fill=C_ACCENT)
        d.text((tx + 24, yy + 11), t, font=F(16), fill=C_TEXT, anchor="lm")

    return img.convert("RGB")


# ------------------------------------------------------- 场景 2：整理后的目录结构
def scene_result():
    img = vgrad(W, H, C_BG1, C_BG2).convert("RGBA")
    glow = Image.new("RGBA", (W, H), (0, 0, 0, 0))
    ImageDraw.Draw(glow).ellipse([-200, 260, 620, 1000], fill=(16, 185, 129, 34))
    img = Image.alpha_composite(img, glow.filter(ImageFilter.GaussianBlur(120)))

    px, py, pw, ph = 92, 76, 430, 648
    img = add_shadow(img, [px, py, px + pw, py + ph], radius=18)
    d = ImageDraw.Draw(img)
    d.rounded_rectangle([px, py, px + pw, py + ph], radius=18, fill=C_BG, outline=C_LINE, width=1)

    # 标题条
    d.text((px + 22, py + 34), "书签管理器", font=F(17, True), fill=C_TEXT, anchor="lm")
    d.rounded_rectangle([px + pw - 66, py + 22, px + pw - 22, py + 46], radius=8, fill=C_PANEL)
    d.text((px + pw - 44, py + 34), "整理后", font=F(12), fill=C_MUTED, anchor="mm")
    d.line([(px + 14, py + 58), (px + pw - 14, py + 58)], fill=C_LINE, width=1)

    # 目录树
    tree = [
        (0, "folder", "书签栏", None),
        (1, "folder", "开发技术", C_ACCENT),
        (2, "folder", "前端框架", None),
        (2, "folder", "后端开发", None),
        (2, "folder", "工具链", None),
        (1, "folder", "新闻资讯", (245, 158, 11)),
        (2, "folder", "科技媒体", None),
        (1, "folder", "学习教育", (16, 185, 129)),
        (2, "folder", "在线课程", None),
        (1, "folder", "工具效率", (100, 116, 139)),
        (1, "folder", "影音娱乐", (139, 92, 246)),
        (1, "bookmark", "GitHub  ·  github.com", None),
        (1, "bookmark", "知乎  ·  zhihu.com", None),
    ]
    ty = py + 76
    for depth, kind, label, col in tree:
        x = px + 22 + depth * 22
        if kind == "folder":
            folder_glyph(d, x, ty - 6, 16, 12, col or (203, 213, 225))
            d.text((x + 26, ty), label, font=F(14, False), fill=C_TEXT if depth < 2 else C_MUTED, anchor="lm")
        else:
            bookmark_glyph(d, x + 2, ty - 7, 11, 14, C_WARN)
            d.text((x + 26, ty), label, font=F(13), fill=C_MUTED, anchor="lm")
        ty += 40

    # 底部注解
    d.rounded_rectangle([px + 14, py + ph - 74, px + pw - 14, py + ph - 16], radius=10, fill=C_PANEL)
    d.text((px + 30, py + ph - 56), "子文件夹置顶，直接书签按使用频率从高到低排列", font=F(12), fill=C_MUTED, anchor="lm")
    d.text((px + 30, py + ph - 34), "根目录上的常用书签默认原样保留，不受影响", font=F(12), fill=C_MUTED, anchor="lm")

    # 右侧文案
    tx = 596
    d.text((tx, 190), "从一堆散书签", font=F(42, True), fill=C_TEXT)
    d.text((tx, 244), "变成清晰的分类目录", font=F(42, True), fill=C_OK)
    d.text((tx, 320), "先生成预览供你逐项检查，确认无误再落地。", font=F(17), fill=C_MUTED)
    d.text((tx, 348), "分类文件夹最终提升为书签栏的一级目录。", font=F(17), fill=C_MUTED)

    steps = [
        ("1", "扫描并分类", "只读，不改动任何书签"),
        ("2", "生成预览", "复制一份分类结果供检查"),
        ("3", "执行整理", "删除原书签，目录结构落地"),
    ]
    for i, (n, t, s) in enumerate(steps):
        yy = 412 + i * 62
        d.ellipse([tx, yy, tx + 32, yy + 32], fill=C_ACCENT_D)
        d.text((tx + 16, yy + 16), n, font=F(15, True), fill=(255, 255, 255), anchor="mm")
        d.text((tx + 46, yy + 8), t, font=F(17, True), fill=C_TEXT, anchor="lm")
        d.text((tx + 46, yy + 28), s, font=F(13), fill=C_MUTED, anchor="lm")

    return img.convert("RGB")


# ------------------------------------------------------------ 场景 3：安全与撤销
def scene_flow():
    img = vgrad(W, H, C_BG1, C_BG2).convert("RGBA")
    glow = Image.new("RGBA", (W, H), (0, 0, 0, 0))
    ImageDraw.Draw(glow).ellipse([300, -160, 1180, 420], fill=(59, 91, 219, 42))
    img = Image.alpha_composite(img, glow.filter(ImageFilter.GaussianBlur(120)))
    d = ImageDraw.Draw(img)

    d.text((W / 2, 116), "先预览，再执行，全程可撤销", font=F(46, True), fill=C_TEXT, anchor="mm")
    d.text((W / 2, 168), "删除前自动保存快照，误整理了随时一键还原", font=F(18), fill=C_MUTED, anchor="mm")

    cards = [
        ("扫描并分类", "只读模式\n不动你任何书签", C_ACCENT),
        ("生成预览", "复制一份分类结果\n你亲自检查", C_ACCENT),
        ("执行整理", "确认后才删除原书签\n并提升目录结构", C_DANGER),
        ("撤销还原", "按原位置、原顺序\n完整恢复", C_OK),
    ]
    cw, gap = 250, 34
    total = len(cards) * cw + (len(cards) - 1) * gap
    sx = (W - total) / 2
    cy0, ch = 244, 216

    for i, (title, desc, col) in enumerate(cards):
        x = sx + i * (cw + gap)
        img = add_shadow(img, [x, cy0, x + cw, cy0 + ch], radius=16, blur=18, offset=(0, 10), alpha=110)
        dd = ImageDraw.Draw(img)
        dd.rounded_rectangle([x, cy0, x + cw, cy0 + ch], radius=16, fill=C_PANEL, outline=C_LINE, width=1)
        dd.rounded_rectangle([x, cy0, x + cw, cy0 + 5], radius=2, fill=col)
        dd.ellipse([x + cw / 2 - 25, cy0 + 34, x + cw / 2 + 25, cy0 + 84], fill=tuple(min(255, c + 40) for c in col))
        dd.text((x + cw / 2, cy0 + 59), str(i + 1), font=F(26, True), fill=(255, 255, 255), anchor="mm")
        dd.text((x + cw / 2, cy0 + 116), title, font=F(20, True), fill=C_TEXT, anchor="mm")
        for j, line in enumerate(desc.split("\n")):
            dd.text((x + cw / 2, cy0 + 152 + j * 24), line, font=F(14), fill=C_MUTED, anchor="mm")

        if i < len(cards) - 1:
            ax = x + cw + 6
            ay = cy0 + ch / 2
            dd.polygon([(ax, ay - 8), (ax + 16, ay), (ax, ay + 8)], fill=C_MUTED)

    # 底部安全说明
    by = 520
    dw, dh = 1046, 176
    dx = (W - dw) / 2
    d = ImageDraw.Draw(img)
    d.rounded_rectangle([dx, by, dx + dw, by + dh], radius=16, fill=C_PANEL, outline=C_LINE, width=1)
    d.text((dx + 34, by + 34), "安全设计", font=F(18, True), fill=C_TEXT, anchor="lm")

    items = [
        ("撤回机制", "每次执行前记录书签的原始位置与顺序，撤销时按原样重建"),
        ("精确删除", "只删除本次被整理进预览的书签，未参与整理的绝不触碰"),
        ("数据不外传", "书签只存在你的浏览器中；仅当你主动启用 AI 分类时才会发送到你自己填写的接口"),
    ]
    for i, (k, v) in enumerate(items):
        yy = by + 74 + i * 32
        d.rounded_rectangle([dx + 34, yy + 5, dx + 44, yy + 15], radius=2, fill=C_OK)
        d.text((dx + 58, yy + 10), k, font=F(15, True), fill=C_OK, anchor="lm")
        d.text((dx + 152, yy + 10), v, font=F(14), fill=C_MUTED, anchor="lm")

    return img.convert("RGB")


def main():
    jobs = [
        ("screenshot-1-main.png", scene_main),
        ("screenshot-2-result.png", scene_result),
        ("screenshot-3-flow.png", scene_flow),
    ]
    for name, fn in jobs:
        out = os.path.join(HERE, name)
        im = fn()
        assert im.size == (W, H), f"{name} 尺寸错误: {im.size}"
        assert im.mode == "RGB", f"{name} 必须为 RGB（无 alpha）"
        im.save(out, "PNG")
        print(f"OK  {name}  {im.size[0]}x{im.size[1]}  {os.path.getsize(out)} bytes")


if __name__ == "__main__":
    main()
