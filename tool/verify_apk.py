"""Verify the contents of the Android ARM64 release APK."""
import argparse
import gzip
import hashlib
import json
from pathlib import Path
import re
import sys
import zipfile

PROJECT = Path(__file__).resolve().parents[1]
AVATAR_SHA = "624d0d554bc205bbdc33e22a68a2c3c20edebb3e573011ead8878a65e5329b23"
LABELS_SHA = "b5cd803d59c2808e8dc7cc75aff1ac22480765ec81a30585947c7054fd72af9a"
WHISPER_SHA = "422f1ae452ade6f30a004d7e5c6a43195e4433bc370bf23fac9cc591f01a8898"


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("apk", type=Path, nargs="?", default=PROJECT / "build/app/outputs/flutter-apk/app-release.apk")
    parser.add_argument("--source", type=Path, help="Compare every packaged landmark to the runtime dictionary")
    args = parser.parse_args()
    runtime = None
    if args.source:
        sys.dont_write_bytecode = True
        sys.path.insert(0, str(args.source.resolve()))
        from app.api.sign_lookup import SignDictionary
        runtime = SignDictionary()
        runtime.load()
    with zipfile.ZipFile(args.apk) as apk:
        names = set(apk.namelist())
        native = {path for path in names if path.startswith("lib/") and path.endswith(".so")}
        assert {path.split("/")[1] for path in native} == {"arm64-v8a"}
        libs = {path.split("/")[-1] for path in native}
        assert {"libapp.so", "libflutter.so", "libsignlang_whisper.so", "libonnxruntime.so",
                "libonnxruntime4j_jni.so"} <= libs
        for path in native:
            with apk.open(path) as stream:
                header = stream.read(20)
                assert header[:6] == b"\x7fELF\x02\x01" and header[18:20] == b"\xb7\x00", path
        assert not any(re.search(r"\.(?:mp4|webm|mov)$", name, re.I) for name in names)
        for filename, expected in {
            "avatar/models/avatar.vrm": AVATAR_SHA,
            "models/labels.json": LABELS_SHA,
            "models/ggml-base-q5_1.bin": WHISPER_SHA,
        }.items():
            with apk.open(f"assets/{filename}") as stream:
                assert hashlib.file_digest(stream, "sha256").hexdigest() == expected, filename
        labels = json.loads(apk.read("assets/models/labels.json"))
        assert len(labels) == len(set(labels)) == 224
        dictionary = json.loads(apk.read("assets/signs/dictionary.json"))
        if runtime:
            assert dictionary["entries"] == runtime.vi_to_gloss
            assert dictionary["aliases"] == runtime._aliases
            assert dictionary["release"] == runtime.data_dir.name
        clips = {f"assets/signs/{gloss}.json.gzip" for gloss in dictionary["entries"].values()}
        assert clips == {path for path in names if path.startswith("assets/signs/") and path.endswith(".json.gzip")}
        assert len(clips) >= 500
        assert dictionary["aliases"].keys().isdisjoint(dictionary["entries"])
        assert set(dictionary["aliases"].values()) <= dictionary["entries"].keys()
        for path in clips:
            assert apk.getinfo(path).compress_type == zipfile.ZIP_STORED, path
            with apk.open(path) as stream, gzip.GzipFile(fileobj=stream) as compressed:
                raw = compressed.read()
                if runtime:
                    gloss = path.rsplit("/", 1)[1].removesuffix(".json.gzip")
                    assert raw == runtime.landmark_path(gloss).read_bytes(), path
                data = json.loads(raw)
                assert data["fps"] > 0 and data["frames"], path
                assert any(len(frame.get(hand) or []) == 21
                           for frame in data["frames"] for hand in ("left_hand", "right_hand")), path
        for path in ("avatar/index.html", "avatar/assets/avatar.js", "camera/index.html",
                     "camera/capture.js", "camera/pipeline.js"):
            assert f"assets/{path}" in names, path
        for path in ("models/ggml-base-q5_1.bin", "models/vsl224-rgb.onnx"):
            info = apk.getinfo(f"assets/{path}")
            assert info.compress_type == zipfile.ZIP_STORED, path
        assert apk.getinfo("assets/models/vsl224-rgb.onnx").file_size > 40_000_000
        print(f"APK: {args.apk.stat().st_size} bytes")
        print(f"Native ARM64: {', '.join(sorted(libs))}")
        print(f"Labels: {len(labels)}")
        print(f"Landmarks: {len(clips)} signs, {sum(apk.getinfo(p).file_size for p in clips)} bytes")
        if runtime:
            print(f"Runtime parity: {len(clips)} byte-identical landmarks; {len(runtime._aliases)} aliases")
        for path in ("models/ggml-base-q5_1.bin", "models/vsl224-rgb.onnx",
                     "avatar/models/avatar.vrm", "avatar/models/rigged_hand.glb"):
            print(f"{path}: {apk.getinfo(f'assets/{path}').file_size} bytes")


if __name__ == "__main__":
    main()

