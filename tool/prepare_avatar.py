"""Reuse the source VRM scene and retargeter with local WebView assets."""
import argparse
from pathlib import Path
import shutil

PROJECT = Path(__file__).resolve().parents[1]


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--source", type=Path, default=PROJECT.parent / "signlangue-viesign-training-20261121")
    args = parser.parse_args()
    source = args.source / "app/frontend"
    components = source / "src/components/avatar"
    target = PROJECT / "tool/avatar"
    for name in ("vrm-holistic-retargeter.js", "cue-timeline.js"):
        shutil.copyfile(components / name, target / name)
    scene = (components / "AvatarScene3D.jsx").read_text(encoding="utf-8")
    scene = "import React from 'react';\n" + scene
    scene = scene.replace("'/models/", "'/avatar/models/")
    scene = scene.replace(
        "fetch(`/api/landmarks/${encodeURIComponent(sign.gloss)}`)",
        "fetch(`/signs/${encodeURIComponent(sign.gloss)}.json${sign.online ? '?source=api' : ''}`)",
    )
    scene = scene.replace("const result = await resp.json();", "const result = { data: await resp.json() };")
    scene = scene.replace("const cached = cache.get(sign.gloss);",
                          "const key = sign.online ? 'api:' + sign.gloss : sign.gloss;\n"
                          "        const cached = cache.get(key);")
    scene = scene.replace("cache.set(sign.gloss,", "cache.set(key,").replace("cache.delete(sign.gloss)", "cache.delete(key)")
    scene = scene.replace("cache.set(key, data);", """cache.set(key, data);
            if (cache.size > 24) cache.delete(cache.keys().next().value);""")
    start = scene.index("            // All requests go out at once.")
    finish = scene.index("                let loaded = null;", start)
    scene = scene[:start] + "            for (const sign of foundSigns) {\n" + scene[finish:]
    scene = scene.replace("loaded = await request;", "loaded = await loadLandmarks(sign);")
    scene = scene.replace("setLoadError('WebGL không khởi tạo được. Dùng Chrome/Edge.');",
                          "setLoadError('Không khởi tạo được WebGL 2. Hãy cập nhật Android System WebView.');\n"
                          "            updateStatus('Không khởi tạo được WebGL 2.');")
    scene = scene.replace("setLoadError('Không tải được mô hình 3D.');",
                          "setLoadError('Không tải được mô hình 3D.');\n"
                          "                    updateStatus('Không tải được mô hình 3D.');")
    if "/api/landmarks/" in scene or "/signs/" not in scene:
        raise ValueError("The upstream scene no longer matches the offline loader.")
    (target / "AvatarScene3D.jsx").write_text(scene, encoding="utf-8")
    asset = PROJECT / "android/app/src/main/assets/avatar/models/rigged_hand.glb"
    asset.parent.mkdir(parents=True, exist_ok=True)
    shutil.copyfile(source / "public/models/rigged_hand.glb", asset)


if __name__ == "__main__":
    main()

