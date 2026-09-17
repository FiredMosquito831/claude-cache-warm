"""Generates the 1024x1024 source icon (app-icon.png). Re-run `npx tauri icon app-icon.png` afterwards."""
from pathlib import Path
from PIL import Image, ImageDraw, ImageFont

S = 1024
img = Image.new("RGBA", (S, S), (0, 0, 0, 0))
d = ImageDraw.Draw(img)
# vertical gradient rounded square
grad = Image.new("RGBA", (S, S))
gd = ImageDraw.Draw(grad)
top, bot = (255, 149, 0), (217, 60, 21)
for y in range(S):
    t = y / (S - 1)
    gd.line([(0, y), (S, y)], fill=tuple(int(top[i] + (bot[i] - top[i]) * t) for i in range(3)) + (255,))
mask = Image.new("L", (S, S), 0)
ImageDraw.Draw(mask).rounded_rectangle([40, 40, S - 40, S - 40], radius=220, fill=255)
img.paste(grad, (0, 0), mask)
font = None
for name in ("segoeuib.ttf", "arialbd.ttf", "DejaVuSans-Bold.ttf"):
    try:
        font = ImageFont.truetype(name, 470)
        break
    except OSError:
        pass
if font is None:
    font = ImageFont.load_default()
d.text((S / 2, S / 2 - 10), "CW", font=font, fill=(255, 255, 255, 255), anchor="mm")
out = Path(__file__).resolve().parent.parent / "app-icon.png"
img.save(out)
print(out)
