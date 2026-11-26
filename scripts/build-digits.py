"""Build a renamed, tabular digit-only Outfit derivative. No system font install."""
import hashlib
import json
from pathlib import Path
import sys

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "tmp/font-python"))
from fontTools import subset, version as fonttools_version
from fontTools.ttLib import TTFont
from fontTools.varLib.instancer import instantiateVariableFont
from fontTools.pens.recordingPen import DecomposingRecordingPen
from fontTools.pens.transformPen import TransformPen
from fontTools.pens.ttGlyphPen import TTGlyphPen

source = ROOT / "tmp/font-source/Outfit[wght].ttf"
weight = int(sys.argv[1]) if len(sys.argv) > 1 else 700
assert weight in (350, 700, 800), "Supported display weights: 350, 700, 800"
output = ROOT / "frontend/public/fonts"
output.mkdir(parents=True, exist_ok=True)
font = instantiateVariableFont(TTFont(source, recalcTimestamp=False), {"wght": weight}, inplace=True)
options = subset.Options()
options.hinting = False
options.name_IDs = [0, 1, 2, 3, 4, 5, 6, 13, 14]
subsetter = subset.Subsetter(options=options)
subsetter.populate(text="0123456789:")
subsetter.subset(font)
glyphset = font.getGlyphSet()
cmap = font.getBestCmap()
for codepoint, name in cmap.items():
    glyph = font["glyf"][name]
    glyph.recalcBounds(font["glyf"])
    width = glyph.xMax - glyph.xMin
    advance = 230 if codepoint == ord(":") else 670
    bearing = round((advance - width) / 2)
    recording = DecomposingRecordingPen(glyphset)
    glyphset[name].draw(recording)
    pen = TTGlyphPen(None)
    recording.replay(TransformPen(pen, (1, 0, 0, 1, bearing - glyph.xMin, 0)))
    font["glyf"][name] = pen.glyph()
    font["hmtx"].metrics[name] = (advance, bearing)
colon = TTGlyphPen(None)
for cy in (250, 480):
    cx, r = 115, 40
    colon.moveTo((cx + r, cy))
    colon.qCurveTo((cx + r, cy + r), (cx, cy + r))
    colon.qCurveTo((cx - r, cy + r), (cx - r, cy))
    colon.qCurveTo((cx - r, cy - r), (cx, cy - r))
    colon.qCurveTo((cx + r, cy - r), (cx + r, cy))
    colon.closePath()
font["glyf"][cmap[ord(":")]] = colon.glyph()
font["hmtx"].metrics[cmap[ord(":")]] = (230, 75)
for table in ("GSUB", "GPOS", "GDEF"):
    if table in font:
        del font[table]
font["hhea"].ascent = 800
font["hhea"].descent = -80
font["hhea"].lineGap = 0
font["OS/2"].sTypoAscender = 800
font["OS/2"].sTypoDescender = -80
font["OS/2"].sTypoLineGap = 0
font["OS/2"].usWinAscent = 800
font["OS/2"].usWinDescent = 80
font["OS/2"].fsSelection |= 1 << 7
style = {350: "Light", 700: "Bold", 800: "ExtraBold"}[weight]
names = {1: "Cos Timer Digits", 2: style, 3: f"CosTimerDigits-{weight}-Compact", 4: f"Cos Timer Digits Compact {style}", 6: f"CosTimerDigits-Compact{style}"}
for record in font["name"].names:
    if record.nameID in names:
        record.string = names[record.nameID].encode(record.getEncoding())
font.recalcTimestamp = False
font.flavor = "woff2"
destination = output / ("cos-timer-digits.woff2" if weight == 700 else f"cos-timer-digits-{style.lower()}.woff2")
font.save(destination)
digest = hashlib.sha256(destination.read_bytes()).hexdigest()
hashed_name = f"cos-timer-digits-{digest[:12]}.woff2" if weight == 700 else f"cos-timer-digits-{style.lower()}-{digest[:12]}.woff2"
(output / hashed_name).write_bytes(destination.read_bytes())
import re
if weight == 700:
    for filename in [ROOT / "frontend/style.css", ROOT / "frontend/index.html"]:
        content = filename.read_text(encoding="utf-8")
        content = re.sub(r"/fonts/cos-timer-digits(?:-[a-f0-9]+)?\.woff2", f"/fonts/{hashed_name}", content)
        filename.write_text(content, encoding="utf-8")
else:
    css_file = ROOT / "frontend/style.css"
    content = css_file.read_text(encoding="utf-8")
    face = f'@font-face {{ font-family: "Cos Timer Digits"; src: url(\'/fonts/{hashed_name}\') format(\'woff2\'); font-style: normal; font-weight: {weight}; font-display: swap; }}'
    pattern = rf'@font-face \{{ font-family: "Cos Timer Digits";[^\n]*font-weight: {weight};[^\n]*\}}'
    if re.search(pattern, content):
        content = re.sub(pattern, face, content)
    else:
        content = content.replace('@custom-variant dark', face + '\n@custom-variant dark', 1)
    css_file.write_text(content, encoding="utf-8")
result = TTFont(destination)
assert set(result.getBestCmap()) == {ord(c) for c in "0123456789:"}
assert len({result["hmtx"].metrics[result.getBestCmap()[ord(c)]][0] for c in "0123456789"}) == 1
(output / "OFL-Outfit.txt").write_bytes((ROOT / "tmp/font-source/OFL.txt").read_bytes())
variant = {
    "source": "https://raw.githubusercontent.com/google/fonts/main/ofl/outfit/Outfit%5Bwght%5D.ttf",
    "license": "https://raw.githubusercontent.com/google/fonts/main/ofl/outfit/OFL.txt",
    "sourceSha256": hashlib.sha256(source.read_bytes()).hexdigest(),
    "sha256": hashlib.sha256(destination.read_bytes()).hexdigest(),
    "file": hashed_name,
    "fontTools": fonttools_version, "weight": weight, "characters": "0123456789:",
    "adaptation": "Static weight; renamed; compact tabular digit advances 670, colon 230; centered digits and newly drawn centered colon dots; no alphabet glyphs; no hinting; WOFF2.",
}
metadata = output / "font-source.json"
receipt = json.loads(metadata.read_text(encoding="utf-8")) if metadata.exists() else {}
variants = receipt.get("variants", [{key: value for key, value in receipt.items() if key != "variants"}] if receipt else [])
if weight == 700:
    receipt.update(variant)
receipt["variants"] = sorted([item for item in variants if item.get("weight") != weight] + [variant], key=lambda item: item["weight"])
(output / "font-source.json").write_text(json.dumps(receipt, indent=2) + "\n", encoding="utf-8")
print(json.dumps({"font": str(destination), "bytes": destination.stat().st_size, "builtWeight": weight, **variant}))
