"""Cross-compile the Whisper JNI library with the Android NDK on Windows."""
import argparse
import hashlib
from pathlib import Path
import shutil
import subprocess
import tarfile

ROOT = Path(__file__).resolve().parents[1]


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--sdk", type=Path, default=Path("D:/Android/Sdk"))
    parser.add_argument("--ndk", default="28.2.13676358")
    args = parser.parse_args()
    vendor = ROOT / "tool/vendor"
    model = ROOT / "android/app/src/main/assets/models/ggml-base-q5_1.bin"
    with model.open("rb") as stream:
        if hashlib.file_digest(stream, "sha256").hexdigest() != "422f1ae452ade6f30a004d7e5c6a43195e4433bc370bf23fac9cc591f01a8898":
            raise ValueError(f"Unexpected Whisper Base Q5 model: {model}")
    cmake = vendor / "buildtools/cmake/data/bin/cmake.exe"
    ninja = vendor / "buildtools/bin/ninja.exe"
    source = vendor / "whisper.cpp-1.8.3"
    if not (source / "CMakeLists.txt").is_file():
        with tarfile.open(vendor / "whisper-v1.8.3.tar.gz") as archive:
            archive.extractall(vendor, filter="data")
    build = ROOT / "build/whisper-arm64"
    toolchain = args.sdk / "ndk" / args.ndk / "build/cmake/android.toolchain.cmake"
    subprocess.run([cmake, "-S", ROOT / "android/app/src/main/cpp", "-B", build, "-G", "Ninja",
                    f"-DCMAKE_MAKE_PROGRAM={ninja}", f"-DCMAKE_TOOLCHAIN_FILE={toolchain}",
                    "-DANDROID_ABI=arm64-v8a", "-DANDROID_PLATFORM=android-24",
                    "-DANDROID_STL=c++_static", "-DCMAKE_BUILD_TYPE=Release",
                    f"-DWHISPER_SOURCE={source}"], check=True)
    subprocess.run([cmake, "--build", build, "--parallel", "4"], check=True)
    destination = ROOT / "android/app/src/main/jniLibs/arm64-v8a"
    destination.mkdir(parents=True, exist_ok=True)
    shutil.copyfile(build / "libsignlang_whisper.so", destination / "libsignlang_whisper.so")
    notices = ROOT / "android/app/src/main/assets/notices"
    notices.mkdir(parents=True, exist_ok=True)
    shutil.copyfile(source / "LICENSE", notices / "WHISPER-LICENSE.txt")


if __name__ == "__main__":
    main()

