#!/usr/bin/env python3
"""Build the Korean onboarding motion graphic with the Storyboarding skill.

The skill's kit uses IBM Plex (Latin only), so this wrapper adds a Hangul subset of the
repository's bundled Pretendard (assets/fonts, SIL OFL) as the fallback for both families.

usage:
  python build.py [-o out/onboarding-ko.html] [--skill ~/.claude/skills/storyboarding]
  python <skill>/scripts/render.py out/onboarding-ko.html --keyframes out/frames
  python <skill>/scripts/render.py out/onboarding-ko.html --mp4 out/onboarding-ko.mp4

Needs: the Storyboarding skill (github.com/deepdivekr/Storyboarding-skill), fonttools + brotli.
"""
import argparse, base64, io, json, string, sys
from pathlib import Path

HERE = Path(__file__).resolve().parent
PRETENDARD = HERE.parents[2] / "assets" / "fonts" / "PretendardVariable.woff2"

KIT_FONTS = """const M = '"PM", "DejaVu Sans Mono", monospace', S = '"PS", "Helvetica Neue", Arial, sans-serif';"""
KIT_FONTS_KO = """const M = '"PM", "PK", "DejaVu Sans Mono", monospace', S = '"PS", "PK", "Helvetica Neue", Arial, sans-serif';"""
KIT_DEFS = "['PS',FONTS.s600,{weight:'600'}]];"
KIT_DEFS_KO = "['PS',FONTS.s600,{weight:'600'}],['PK',FONTS.pk,{weight:'100 900'}]];"


def hangul_subset(text):
    from fontTools import subset
    opts = subset.Options()
    opts.flavor = "woff2"
    opts.layout_features = ["*"]
    font = subset.load_font(str(PRETENDARD), opts)
    sub = subset.Subsetter(opts)
    sub.populate(text=text + string.printable + "·…→←—✓✕●")
    sub.subset(font)
    buf = io.BytesIO()
    subset.save_font(font, buf, opts)
    return buf.getvalue()


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("storyboard", nargs="?", default=str(HERE / "storyboard.json"))
    ap.add_argument("-o", "--out", default=str(HERE / "out" / "onboarding-ko.html"))
    ap.add_argument("--skill", default=str(Path.home() / ".claude" / "skills" / "storyboarding"))
    a = ap.parse_args()
    skill = Path(a.skill).expanduser().resolve()
    sys.path.insert(0, str(skill / "scripts"))
    import build as sb_build  # the skill's build.py: validation, fonts and player shell

    sb_path = Path(a.storyboard).resolve()
    sb = json.loads(sb_path.read_text())
    scene = (sb_path.parent / sb["scene"]).read_text()
    errs, warns = sb_build.check_scene(sb, scene)
    for m in warns: print("warn:", m)
    if errs:
        for m in errs: print("error:", m)
        sys.exit(1)

    kit = (sb_build.ASSETS / "kit.js").read_text()
    if KIT_FONTS not in kit or KIT_DEFS not in kit:
        sys.exit("error: this Storyboarding kit version has different font definitions; update build.py")
    kit = kit.replace(KIT_FONTS, KIT_FONTS_KO).replace(KIT_DEFS, KIT_DEFS_KO)

    fonts = {k: base64.b64encode((sb_build.ASSETS / "fonts" / f).read_bytes()).decode() for k, f in sb_build.FONT_FILES.items()}
    fonts["pk"] = base64.b64encode(hangul_subset(sb_path.read_text() + scene)).decode()
    html = (sb_build.ASSETS / "engine.html").read_text()
    html = html.replace("/*__KIT__*/", kit).replace("/*__TEMPLATE__*/", scene)
    html = html.replace("__TITLE__", f"{sb['meta'].get('name', 'storyboard')} 첫 실행")
    html = html.replace("__FONTS__", json.dumps(fonts))
    html = html.replace("__STORYBOARD__", json.dumps(sb, ensure_ascii=False).replace("</", "<\\/"))
    out = Path(a.out); out.parent.mkdir(parents=True, exist_ok=True); out.write_text(html)
    secs = sum(s.get("sec", 8) for s in sb["shots"])
    print(f"ok: {out}  ({len(sb['shots'])} shots, {secs:.1f}s loop, hangul font {len(fonts['pk'])//1024} KB b64)")


if __name__ == "__main__":
    main()
