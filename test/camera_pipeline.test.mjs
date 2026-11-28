import assert from 'node:assert/strict';
import test from 'node:test';
import { frameIndices, planarRgb, motionScore, MotionSegments } from '../android/app/src/main/assets/camera/pipeline.js';

test('samples the midpoint of each of the 16 equal time intervals', () => {
    assert.deepEqual(frameIndices(12), [0,1,1,2,3,4,4,5,6,7,7,8,9,10,10,11]);
    assert.deepEqual(frameIndices(44), [1,4,6,9,12,15,17,20,23,26,28,31,34,37,39,42]);
});

test('produces RGB uint8 in channel-major order with correct time indexing', () => {
    const frames = Array.from({ length: 12 }, (_, i) => Uint8ClampedArray.of(i, 100 + i, 200 + i, 255));
    const output = planarRgb(frames, 1);
    const expected = frameIndices(12);
    assert.ok(output instanceof Uint8Array);
    assert.deepEqual([...output], [0,100,200].flatMap(base => expected.map(i => base + i)));
});

test('matches the strongest 8 by 8 block and reuses events across forced cuts', () => {
    const previous = new Uint8ClampedArray(64 * 48 * 4);
    const current = previous.slice();
    for (let y = 0; y < 8; y++) current.fill(30, y * 256, y * 256 + 32);
    assert.equal(motionScore(previous, current), 30);
    const detector = new MotionSegments();
    const clips = [];
    function feed(count, score) {
        for (let i = 0; i < count; i++) {
            const clip = detector.add(i, score);
            if (clip) clips.push([clip.id, clip.frames.length]);
        }
    }
    feed(4, 0);
    feed(55, 22);
    feed(5, 0);
    feed(12, 22);
    feed(3, 0);
    assert.deepEqual(clips, [[1, 44], [1, 17], [2, 15]]);
});

