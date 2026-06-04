from pathlib import Path
from random import Random

from PIL import Image, ImageDraw, ImageEnhance, ImageFilter, ImageFont


ROOT = Path(__file__).resolve().parents[1]
OUT = ROOT / "public" / "signal-command-center.png"
W, H = 2400, 1400
rng = Random(42)


def load_font(size: int, bold: bool = False) -> ImageFont.FreeTypeFont | ImageFont.ImageFont:
    candidates = [
        "/System/Library/Fonts/Supplemental/Avenir Next.ttc",
        "/System/Library/Fonts/Helvetica.ttc",
        "/System/Library/Fonts/Supplemental/Arial.ttf",
        "/Library/Fonts/Arial.ttf",
    ]
    for candidate in candidates:
        try:
            return ImageFont.truetype(candidate, size=size, index=1 if bold else 0)
        except Exception:
            continue
    return ImageFont.load_default()


font_18 = load_font(18)
font_22 = load_font(22)
font_26 = load_font(26, True)
font_34 = load_font(34, True)
font_48 = load_font(48, True)
font_82 = load_font(82, True)


def panel(draw: ImageDraw.ImageDraw, xy: tuple[int, int, int, int], title: str) -> None:
    draw.rounded_rectangle(xy, radius=28, fill=(22, 27, 24, 225), outline=(238, 244, 220, 55), width=2)
    x1, y1, x2, _ = xy
    draw.text((x1 + 34, y1 + 26), title, fill=(238, 244, 220, 235), font=font_26)
    draw.line((x1 + 34, y1 + 70, x2 - 34, y1 + 70), fill=(238, 244, 220, 45), width=2)


def chip(
    draw: ImageDraw.ImageDraw,
    x: int,
    y: int,
    text: str,
    fill: tuple[int, int, int, int],
    text_fill: tuple[int, int, int, int] = (13, 15, 13, 255),
) -> None:
    width = int(draw.textlength(text, font=font_18)) + 34
    draw.rounded_rectangle((x, y, x + width, y + 38), radius=19, fill=fill)
    draw.text((x + 17, y + 9), text, fill=text_fill, font=font_18)


def add_noise(image: Image.Image) -> Image.Image:
    noise = Image.effect_noise((W, H), 21).convert("L")
    alpha = ImageEnhance.Contrast(noise).enhance(1.6)
    overlay = Image.new("RGBA", (W, H), (238, 244, 220, 0))
    overlay.putalpha(alpha.point(lambda p: 18 if p > 138 else 0))
    return Image.alpha_composite(image, overlay)


base = Image.new("RGBA", (W, H), (14, 18, 16, 255))
draw = ImageDraw.Draw(base, "RGBA")

for y in range(0, H, 80):
    draw.line((0, y, W, y), fill=(238, 244, 220, 15), width=1)
for x in range(0, W, 80):
    draw.line((x, 0, x, H), fill=(238, 244, 220, 13), width=1)

for i in range(32):
    x = rng.randint(-200, W + 100)
    y = rng.randint(40, H - 80)
    length = rng.randint(220, 680)
    color = [(182, 255, 69, 28), (255, 91, 59, 22), (60, 196, 203, 24), (247, 204, 69, 20)][i % 4]
    draw.line((x, y, x + length, y - rng.randint(35, 130)), fill=color, width=rng.randint(4, 9))

draw.text((130, 118), "SIGNAL", fill=(238, 244, 220, 255), font=font_82)
draw.text((132, 216), "permissioned inbox intelligence", fill=(182, 255, 69, 235), font=font_26)
draw.text((1640, 126), "LIVE SIGNAL SURFACE", fill=(238, 244, 220, 200), font=font_34)
draw.text((1640, 177), "Gmail + Outlook + CRM", fill=(238, 244, 220, 135), font=font_22)

panel(draw, (150, 330, 670, 1040), "Connected sources")
sources = [
    ("Gmail", "142 threads indexed", (182, 255, 69, 245)),
    ("Outlook", "98 conversations watched", (60, 196, 203, 245)),
    ("CRM", "61 accounts linked", (247, 204, 69, 245)),
    ("Calendar", "28 executive touches", (255, 91, 59, 245)),
]
for idx, (name, count, color) in enumerate(sources):
    y = 430 + idx * 126
    draw.rounded_rectangle((205, y, 615, y + 86), radius=20, fill=(238, 244, 220, 18), outline=(238, 244, 220, 36), width=1)
    draw.ellipse((232, y + 25, 269, y + 62), fill=color)
    draw.text((292, y + 19), name, fill=(238, 244, 220, 245), font=font_26)
    draw.text((292, y + 51), count, fill=(238, 244, 220, 150), font=font_18)

for y in [470, 596, 722, 848]:
    draw.line((620, y, 840, y + rng.randint(-36, 36)), fill=(182, 255, 69, 56), width=4)

panel(draw, (800, 260, 1545, 1120), "Signal feed")
events = [
    ("Roadmap pull", "8 customers asked for SOC2 exports", "+37 idea velocity", (182, 255, 69, 245)),
    ("Expansion intent", "Finance asked for usage rollups", "81 account score", (247, 204, 69, 245)),
    ("Renewal risk", "Champion moved to competitor", "22 day window", (255, 91, 59, 245)),
    ("Relationship drift", "No exec response in 19 days", "3 owners nudged", (60, 196, 203, 245)),
    ("New segment", "Healthcare teams ask for PHI review", "14 thread cluster", (238, 244, 220, 220)),
]
for idx, (label, detail, score, color) in enumerate(events):
    y = 378 + idx * 130
    draw.rounded_rectangle((858, y, 1488, y + 96), radius=24, fill=(238, 244, 220, 17), outline=(238, 244, 220, 34), width=1)
    draw.ellipse((893, y + 27, 935, y + 69), fill=color)
    draw.text((958, y + 19), label, fill=(238, 244, 220, 245), font=font_26)
    draw.text((958, y + 53), detail, fill=(238, 244, 220, 142), font=font_18)
    chip(draw, 1280, y + 30, score, color)

panel(draw, (1630, 300, 2235, 805), "Relationship health")
center = (1918, 535)
for radius, alpha in [(178, 26), (132, 44), (84, 72)]:
    draw.ellipse((center[0] - radius, center[1] - radius, center[0] + radius, center[1] + radius), outline=(238, 244, 220, alpha), width=2)
for angle_idx, (name, color) in enumerate(
    [("Exec", (182, 255, 69, 245)), ("Buyer", (247, 204, 69, 245)), ("User", (60, 196, 203, 245)), ("Risk", (255, 91, 59, 245))]
):
    x = center[0] + [-124, 130, 62, -88][angle_idx]
    y = center[1] + [-70, -52, 122, 112][angle_idx]
    draw.line((center[0], center[1], x, y), fill=color[:3] + (95,), width=4)
    draw.ellipse((x - 20, y - 20, x + 20, y + 20), fill=color)
    draw.text((x - 34, y + 29), name, fill=(238, 244, 220, 175), font=font_18)
draw.ellipse((center[0] - 38, center[1] - 38, center[0] + 38, center[1] + 38), fill=(238, 244, 220, 230))
draw.text((center[0] - 24, center[1] - 16), "74", fill=(14, 18, 16, 255), font=font_34)
draw.text((1664, 724), "3 accounts need a human touch this week", fill=(238, 244, 220, 165), font=font_22)

panel(draw, (1630, 850, 2235, 1222), "Idea radar")
draw.line((1718, 1138, 2140, 1138), fill=(238, 244, 220, 50), width=2)
draw.line((1718, 930, 1718, 1138), fill=(238, 244, 220, 50), width=2)
draw.text((1742, 1156), "frequency", fill=(238, 244, 220, 116), font=font_18)
draw.text((1648, 924), "value", fill=(238, 244, 220, 116), font=font_18)
points = [
    (1830, 1008, "API", (182, 255, 69, 245)),
    (1990, 964, "SSO", (247, 204, 69, 245)),
    (2078, 1066, "CSV", (60, 196, 203, 245)),
    (1904, 1110, "AI", (255, 91, 59, 245)),
]
for x, y, label, color in points:
    draw.ellipse((x - 24, y - 24, x + 24, y + 24), fill=color)
    draw.text((x + 32, y - 13), label, fill=(238, 244, 220, 210), font=font_22)

chip(draw, 885, 1010, "Next best action", (182, 255, 69, 245))
chip(draw, 1120, 1010, "Push to Salesforce", (60, 196, 203, 245))
chip(draw, 1365, 1010, "Create roadmap idea", (247, 204, 69, 245))

base = add_noise(base)
base = base.filter(ImageFilter.UnsharpMask(radius=1, percent=105, threshold=3))
opaque = Image.new("RGBA", (W, H), (14, 18, 16, 255))
base = Image.alpha_composite(opaque, base).convert("RGB")
OUT.parent.mkdir(parents=True, exist_ok=True)
base.save(OUT)
print(OUT)
