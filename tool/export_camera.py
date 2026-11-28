"""Export trained VSL224 RGB, verify real-clip parity, and package the best passing model."""
import argparse
import hashlib
import json
from pathlib import Path
import shutil
import sys
import time

import cv2
import numpy as np
import onnx
import onnxruntime as ort
from onnxruntime.quantization import QuantType, quantize_dynamic
import torch

PROJECT = Path(__file__).resolve().parents[1]
CHECKPOINT_SHA256 = "14ad616249e560f293427002b3d14363ece0e32dc2633ecf1b0913fe61555fc1"
LABEL_SHA256 = "b5cd803d59c2808e8dc7cc75aff1ac22480765ec81a30585947c7054fd72af9a"


def checked(path, expected):
    with path.open("rb") as stream:
        actual = hashlib.file_digest(stream, "sha256").hexdigest()
    if actual != expected:
        raise ValueError(f"Unexpected SHA-256 for {path}: {actual}. Supply the actual file, not an LFS pointer.")


def read_video(path, preprocess):
    cap = cv2.VideoCapture(str(path))
    frames = []
    try:
        while True:
            ok, frame = cap.read()
            if not ok:
                break
            frames.append(frame)
    finally:
        cap.release()
    if not frames:
        raise ValueError(f"No video frames in {path}")
    return preprocess(frames).contiguous()


def session(path):
    options = ort.SessionOptions()
    options.intra_op_num_threads = 4
    options.inter_op_num_threads = 1
    return ort.InferenceSession(str(path), options, providers=["CPUExecutionProvider"])


def compare(path, clips, reference, labels):
    runner = session(path)
    rows = []
    for (name, clip), expected in zip(clips, reference, strict=True):
        start = time.perf_counter()
        logits = runner.run(["logits"], {"rgb": clip.numpy()})[0][0]
        duration = round(time.perf_counter() - start, 3)
        top = int(logits.argmax())
        row = {"video": name, "pytorch": labels[int(expected.argmax())], "onnx": labels[top],
               "same_top1": bool(top == expected.argmax()),
               "max_logit_error": float(np.max(np.abs(logits - expected))),
               "cpu_seconds": duration}
        rows.append(row)
        print(json.dumps(row, ensure_ascii=False), flush=True)
    return rows


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--source", type=Path, default=PROJECT.parent / "signlangue-viesign-training-20261121")
    parser.add_argument("--checkpoint", type=Path)
    parser.add_argument("--clips", type=Path, nargs="+")
    args = parser.parse_args()
    source = args.source.resolve()
    runtime = source / "models/camera/vsl224"
    candidates = (runtime / "rgb-best.pt", source / "trian_vls3/results/rgb-best.pt",
                  PROJECT / "tool/vendor/rgb-best.pt")
    checkpoint = args.checkpoint or next(
        (path for path in candidates if path.is_file() and path.stat().st_size > 1024), None)
    if checkpoint is None:
        parser.error("Missing trained RGB checkpoint. Checked: " + ", ".join(map(str, candidates)))
    checked(checkpoint, CHECKPOINT_SHA256)
    labels_file = runtime / "labels.json"
    checked(labels_file, LABEL_SHA256)
    labels = json.loads(labels_file.read_text(encoding="utf-8"))
    if len(labels) != 224 or len(set(labels)) != 224:
        raise ValueError("Expected exactly 224 unique labels.")
    sys.dont_write_bytecode = True
    sys.path.insert(0, str(source))
    from app.api.vsl_model import VSLRGB
    from app.api.camera_recognition import _preprocess

    torch.set_num_threads(4)
    torch.manual_seed(0)
    model = VSLRGB(224).eval()
    model.load_state_dict(torch.load(checkpoint, weights_only=True, map_location="cpu"), strict=True)
    video_paths = args.clips or sorted((source / "train/video").glob("*.mp4"))
    if not video_paths:
        parser.error("Provide real clips via --clips to verify export parity.")
    clips = [(path.name, read_video(path, _preprocess)) for path in video_paths]
    with torch.inference_mode():
        reference = [model(clip).numpy()[0] for _, clip in clips]

    # At mask_ratio=0 every mask unit is visible. The encoder's eval path
    # skips generating and gathering that mask, but keeps the same mean pool.
    class UnmaskedRGB(torch.nn.Module):
        def __init__(self, classifier):
            super().__init__()
            self.classifier = classifier

        def forward(self, rgb):
            classifier = self.classifier
            normalized = (rgb.float() / 255 - classifier.mean) / classifier.std
            return classifier.head(classifier.encoder(normalized, eval=True))

    portable = UnmaskedRGB(model).eval()
    with torch.inference_mode():
        for (_, clip), expected in zip(clips, reference, strict=True):
            np.testing.assert_allclose(expected, portable(clip).numpy()[0], rtol=1e-5, atol=1e-5)

    build = PROJECT / "build/camera"
    build.mkdir(parents=True, exist_ok=True)
    fp32 = build / "vsl224-rgb-fp32.onnx"
    int8 = build / "vsl224-rgb-int8.onnx"
    with torch.inference_mode():
        torch.onnx.export(portable, clips[0][1], str(fp32), input_names=["rgb"],
                          output_names=["logits"], opset_version=17, dynamo=False)
    onnx.checker.check_model(str(fp32))
    fp32_rows = compare(fp32, clips, reference, labels)
    if not all(row["same_top1"] and row["max_logit_error"] < .01 for row in fp32_rows):
        raise ValueError("ONNX FP32 failed PyTorch parity.")
    selected = fp32
    report = {"ort_version": ort.__version__, "fp32": {"bytes": fp32.stat().st_size, "clips": fp32_rows}}
    try:
        # Dynamic W8A8 on linear weights leaves Conv3D and attention softmax in FP32.
        # No calibration set is needed for this method.
        quantize_dynamic(str(fp32), str(int8), op_types_to_quantize=["MatMul", "Gemm"],
                         per_channel=True, weight_type=QuantType.QInt8,
                         extra_options={"MatMulConstBOnly": True})
        onnx.checker.check_model(str(int8))
        int8_rows = compare(int8, clips, reference, labels)
        report["int8"] = {"bytes": int8.stat().st_size, "clips": int8_rows}
        if all(row["same_top1"] and row["max_logit_error"] < 1.0 for row in int8_rows):
            selected = int8
    except (ValueError, RuntimeError, onnx.checker.ValidationError, ort.capi.onnxruntime_pybind11_state.NotImplemented) as error:
        report["int8_error"] = str(error)
    report["selected"] = selected.name
    assets = PROJECT / "android/app/src/main/assets/models"
    assets.mkdir(parents=True, exist_ok=True)
    shutil.copyfile(selected, assets / "vsl224-rgb.onnx")
    shutil.copyfile(labels_file, assets / "labels.json")
    (build / "report.json").write_text(json.dumps(report, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    print(f"Packaged {selected.name} ({selected.stat().st_size} bytes)", flush=True)


if __name__ == "__main__":
    main()

