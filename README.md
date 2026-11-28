# Ký hiệu Việt

Ứng dụng Flutter cho Android ARM64 từ Android 7.0 (API 24), với giao diện giấy và màu nước của SignLang. Thanh điều hướng có Tổng quan, Dịch và Camera. Avatar cần Android System WebView có WebGL 2.

Ứng dụng ưu tiên API của [máy chủ SignLang](https://dutai-gpu.taila6b408.ts.net/) cho nhận dạng giọng nói, tra ký hiệu, lấy landmark, nhận diện clip camera và tạo câu. Trên mạng yêu cầu Tailscale, điện thoại cần kết nối vào tailnet có quyền truy cập. Có thể đổi URL HTTPS hoặc để trống để chỉ xử lý trên thiết bị trong **Tổng quan → Kết nối máy chủ**.

Nhận dạng giọng nói dùng API tiếng Việt qua Wi-Fi hoặc dữ liệu di động. Khi mất Internet, app dùng Whisper Base Q5_1 có sẵn trong APK, nạp nền khi bắt đầu ghi và giữ model trong RAM giữa các lần nhận dạng trên màn Dịch. Nếu Android xác nhận Internet vẫn hoạt động nhưng API gặp lỗi, app hiện lỗi để thử lại. Cả hai luồng cắt các khoảng rất yên ở đầu và cuối bản ghi, giữ 250 ms đệm mỗi phía và giữ khoảng nghỉ giữa câu. Có thể xem thời gian nạp, suy luận và lượt gọi API bằng `adb logcat -s SignLangSpeech`.

## Build từ dự án đã chuẩn bị

Chạy PowerShell tại thư mục `signlang`. Môi trường build đã dùng Flutter 3.47.5, Dart 3.13.4, JDK 21, Android SDK 36 và NDK 28.2.13676358.

```powershell
flutter analyze
flutter test
node --test test/camera_pipeline.test.mjs
flutter build apk --release --target-platform=android-arm64
python tool/verify_apk.py --source ../signlangue-viesign-training-20261121
```

APK ở `build/app/outputs/flutter-apk/app-release.apk`. Đây là build release ký bằng khóa debug của cấu hình dự án để cài thử bằng `adb install`.

## Tạo lại tài nguyên từ đầu

Các lệnh mặc định đọc source bên cạnh tại `../signlangue-viesign-training-20261121`. Các script chuẩn bị dữ liệu hỗ trợ `--source` nếu source ở vị trí khác. Mọi tệp xuất được ghi vào dự án Flutter.

```powershell
New-Item -ItemType Directory -Force tool/vendor,android/app/src/main/assets/models | Out-Null
python -m pip install --target tool/vendor/buildtools cmake==3.31.10 ninja==1.13.0
python -m pip install --no-deps --target tool/vendor/python timm==1.0.30 onnxruntime==1.24.3

curl.exe -fL --retry 2 -o tool/vendor/whisper-v1.8.3.tar.gz https://codeload.github.com/ggml-org/whisper.cpp/tar.gz/refs/tags/v1.8.3
curl.exe -fL --retry 2 -o android/app/src/main/assets/models/ggml-base-q5_1.bin https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-base-q5_1.bin
curl.exe -fL --retry 2 -o tool/vendor/onnxruntime-android-1.24.3.aar https://repo.maven.apache.org/maven2/com/microsoft/onnxruntime/onnxruntime-android/1.24.3/onnxruntime-android-1.24.3.aar
curl.exe -fL --retry 2 -o tool/vendor/rgb-best.pt https://media.githubusercontent.com/media/vanchuong2305wind/signlangue/viesign-training-20261121/trian_vls3/results/rgb-best.pt

python tool/build_whisper.py --sdk D:/Android/Sdk
python tool/pack_signs.py
python tool/prepare_avatar.py
npm.cmd --prefix tool/avatar ci
npm.cmd --prefix tool/avatar run build

$env:PYTHONPATH = (Resolve-Path tool/vendor/python).Path
$env:PYTHONUTF8 = '1'
python -u tool/export_camera.py
flutter build apk --release --target-platform=android-arm64
python tool/verify_apk.py --source ../signlangue-viesign-training-20261121
```

Bước export cần Python 3.12 cùng PyTorch 2.6, torchvision 0.21, NumPy, OpenCV, ONNX và các dependency của timm. Script kiểm tra SHA-256 của checkpoint 203.943.238 byte và thứ tự nhãn rồi nạp toàn bộ trọng số. Có thể truyền `--checkpoint` và `--clips`.

Gói mặc định nạp đúng `SignDictionary` đang chạy của source, gồm release `release-1609a71658735fe81ca0`, 3.393 mục VieSign, 1.073 mục ASL bổ sung và 20 alias. Sau khi giải nén, từng tệp landmark trùng từng byte với nguồn được backend chọn. Danh sách mục từ nằm ở `tool/selected-signs.txt`. Lệnh `python tool/pack_signs.py --limit 700` tạo bản thu gọn, khi đó dùng `python tool/verify_apk.py` để kiểm tra nội dung APK.

## Kiểm thử

- `tool/verify_apk.py` đọc 224 nhãn và từng JSON landmark gzip trực tiếp trong APK, kiểm tra checksum avatar, model Whisper và thư viện ELF ARM64.
- `tool/export_camera.py` so sánh logits và nhãn top-1 giữa PyTorch, ONNX FP32 và ONNX INT8 trên cùng clip. Báo cáo nằm trong `build/camera/report.json`. Lượng tử hóa động W8A8 áp dụng cho các lớp tuyến tính, giữ Conv3D và softmax ở FP32. Phương pháp này không cần dữ liệu hiệu chuẩn.
- Có thể thử avatar trên Chrome desktop bằng `node test/avatar_browser_smoke.mjs 'C:/Program Files/Google/Chrome/Application/chrome.exe'`. Bài thử tải VRM và phát hai ký hiệu từ landmark gzip qua máy chủ vòng lặp cục bộ.
- Khi có điện thoại ARM64, cài mới APK, bật chế độ máy bay trước khi mở, thử từ chối rồi cấp quyền mic và camera. Ghi âm một câu tiếng Việt, sửa bản ghi và phát avatar. Sau đó thử các ký hiệu trong danh sách VSL224, ngắt nhẹ giữa từng ký hiệu và kiểm tra câu đề xuất.

Camera lấy 16 khung theo điểm giữa của từng khoảng thời gian bằng nhau, resize trực tiếp về 224×224 và giữ RGB uint8. Nhánh máy chủ gửi 16 ảnh JPEG đến API hiện có. Nhánh cục bộ dùng trực tiếp tensor RGB và ONNX chuẩn hóa một lần. Camera trước hiển thị ảnh gương và gửi pixel theo hướng gốc đã được WebView xoay thẳng. Mỗi đoạn chuyển động cho tối đa một nhãn được chấp nhận. Ngưỡng 0,45 cho độ tin cậy và 0,12 cho chênh lệch hai nhãn đầu lấy từ dự án nguồn. Câu dự phòng cục bộ ghép theo thứ tự và giữ từ phủ định, từ lặp. Có thể sửa câu trước khi sao chép.

Thông tin giấy phép nằm trong `android/app/src/main/assets/notices`. Trọng số VSL224 và bản chuyển đổi ONNX được phân phối theo CC BY-NC-SA 4.0. Avatar Seed-san dùng giấy phép VRM Public License 1.0.

