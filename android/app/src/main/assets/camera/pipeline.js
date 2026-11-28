export const frameCount = 16;
export const imageSide = 224;
const width = 64;
const height = 48;
const blocksAcross = 8;
const blockSide = 8;

export function frameIndices(count) {
    if (count < 1) throw new RangeError('Empty camera clip');
    return Array.from({ length: frameCount }, (_, i) => Math.floor((i + 0.5) * count / frameCount));
}

export function planarRgb(frames, side = imageSide) {
    const area = side * side;
    const plane = frameCount * area;
    const rgb = new Uint8Array(3 * plane);
    frameIndices(frames.length).forEach((index, time) => {
        const frame = frames[index];
        for (let pixel = 0; pixel < area; pixel++) {
            const offset = time * area + pixel;
            rgb[offset] = frame[4 * pixel];
            rgb[plane + offset] = frame[4 * pixel + 1];
            rgb[2 * plane + offset] = frame[4 * pixel + 2];
        }
    });
    return rgb;
}

export function motionScore(previous, current) {
    if (!previous) return 0;
    const sums = new Float64Array(48);
    for (let pixel = 0; pixel < width * height; pixel++) {
        const x = pixel % width;
        const y = Math.floor(pixel / width);
        const block = Math.floor(y / blockSide) * blocksAcross + Math.floor(x / blockSide);
        const base = pixel * 4;
        for (let channel = 0; channel < 3; channel++) {
            sums[block] += Math.abs(current[base + channel] - previous[base + channel]);
        }
    }
    return Math.max(...sums) / (blockSide * blockSide * 3);
}

// Ported from Camera.jsx and createSignEventTracker in camera-sentence.js.
export class MotionSegments {
    nextId = 0;
    activeId = null;
    clipId = null;
    quietTicks = 0;
    segmentQuietTicks = 0;
    cooldown = 0;
    preRoll = [];
    frames = [];

    add(frame, score) {
        const quiet = score < 7;
        this.quietTicks = quiet ? this.quietTicks + 1 : 0;
        if (this.quietTicks >= 3) this.activeId = null;
        if (this.clipId === null) {
            if (this.cooldown > 0) {
                this.cooldown--;
                return null;
            }
            this.preRoll.push(frame);
            if (this.preRoll.length > 4) this.preRoll.shift();
            if (score > 14) {
                this.activeId ??= ++this.nextId;
                this.clipId = this.activeId;
                this.frames = this.preRoll;
                this.preRoll = [];
                this.segmentQuietTicks = 0;
            }
            return null;
        }

        this.frames.push(frame);
        this.segmentQuietTicks = quiet ? this.segmentQuietTicks + 1 : 0;
        if (this.segmentQuietTicks < 3 && this.frames.length < 44) return null;
        const result = { id: this.clipId, frames: this.frames };
        this.cooldown = this.segmentQuietTicks >= 3 ? 2 : 0;
        this.clipId = null;
        this.frames = [];
        return result.frames.length >= 12 ? result : null;
    }
}

