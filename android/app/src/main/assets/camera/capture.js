import { imageSide, planarRgb, motionScore, MotionSegments } from './pipeline.js';

const video = document.querySelector('video');
const camera = window.SignLang;
const canvas = (width, height) => {
    const element = document.createElement('canvas');
    element.width = width;
    element.height = height;
    return element.getContext('2d', { alpha: false, willReadFrequently: true });
};
const sample = canvas(64, 48);
const rgb = canvas(imageSide, imageSide);
const queue = [];
let segments;
let previous;
let timer;
let stream;
let session = 0;
let busy = false;
let lastFrameTime = -1;
let facingMode = 'user';

function pixels(context) {
    const { width, height } = context.canvas;
    context.drawImage(video, 0, 0, width, height);
    return context.getImageData(0, 0, width, height).data;
}

function processQueue() {
    if (busy || !queue.length) return;
    const job = queue.shift();
    busy = true;
    camera.status('Đang nhận diện clip…');
    const bytes = planarRgb(job.frames);
    let raw = '';
    for (let i = 0; i < bytes.length; i += 8192) {
        raw += String.fromCharCode(...bytes.subarray(i, i + 8192));
    }
    camera.recognize(job.session, job.id, btoa(raw));
}

window.cameraResult = (run, event, result) => {
    busy = false;
    if (session === run) {
        if (result.error) {
            window.stopCamera(false);
            camera.cameraState(false);
            camera.status(result.error);
            return;
        }
        camera.prediction(run + ':' + event, result.word, result.confidence, result.margin);
        if (!queue.length) {
            camera.status(result.online
                ? 'Đang chờ ký hiệu tiếp theo · Máy chủ'
                : 'Đang chờ ký hiệu tiếp theo · Thiết bị');
        }
    }
    processQueue();
};

function capture() {
    if (video.readyState < HTMLMediaElement.HAVE_CURRENT_DATA || video.currentTime === lastFrameTime) return;
    lastFrameTime = video.currentTime;
    const current = pixels(sample);
    const score = motionScore(previous, current);
    previous = current;
    // Chrome displays decoded frames in their upright orientation. Only the CSS
    // preview is mirrored. Canvas reads the original pixels for the classifier.
    const clip = segments.add(pixels(rgb), score);
    if (!clip) return;
    if (queue.length >= 2) {
        camera.status('Đang xử lý các clip trước. Hãy thử lại ký hiệu vừa rồi.');
        return;
    }
    queue.push({ ...clip, session });
    processQueue();
}

window.stopCamera = (notify = true) => {
    session++;
    clearInterval(timer);
    timer = undefined;
    stream?.getTracks().forEach(track => track.stop());
    stream = undefined;
    video.srcObject = null;
    queue.length = 0;
    if (notify) {
        camera.cameraState(false);
        camera.status('Camera đã dừng.');
    }
};

window.startCamera = async () => {
    if (stream) return;
    const run = ++session;
    try {
        const opened = await navigator.mediaDevices.getUserMedia({
            video: {
                facingMode: facingMode === 'user' ? { ideal: 'user' } : { exact: 'environment' },
                width: { ideal: 640 }, height: { ideal: 480 },
            },
            audio: false,
        });
        if (run !== session) {
            opened.getTracks().forEach(track => track.stop());
            return;
        }
        stream = opened;
        video.srcObject = stream;
        const actualFacing = opened.getVideoTracks()[0].getSettings().facingMode ?? facingMode;
        video.classList.toggle('mirrored', actualFacing === 'user');
        await video.play();
        if (run !== session) return;
        segments = new MotionSegments();
        previous = null;
        lastFrameTime = -1;
        timer = setInterval(capture, 125);
        camera.cameraState(true);
        camera.status('Đang chờ ký hiệu…');
    } catch (error) {
        if (run !== session) return;
        window.stopCamera(false);
        facingMode = 'user';
        camera.cameraState(false);
        camera.status(error.name === 'NotAllowedError'
            ? 'Camera chưa được cấp quyền. Hãy kiểm tra quyền rồi thử lại.'
            : 'Không mở được camera. Hãy thử lại.');
    }
};

window.switchCamera = () => {
    window.stopCamera(false);
    facingMode = facingMode === 'user' ? 'environment' : 'user';
    void window.startCamera();
};

camera.status('Camera sẵn sàng.');
camera.viewReady();

