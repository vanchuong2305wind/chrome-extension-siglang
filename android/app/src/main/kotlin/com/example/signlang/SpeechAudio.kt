package com.example.signlang

import java.nio.ByteBuffer
import java.nio.ByteOrder

internal const val SPEECH_SAMPLE_RATE = 16000
private const val WINDOW = SPEECH_SAMPLE_RATE / 50
private const val EDGE_PADDING = SPEECH_SAMPLE_RATE / 4
private const val QUIET_RMS = 64

internal fun trimQuietEdges(samples: ShortArray): ShortArray {
    fun quiet(start: Int, end: Int): Boolean {
        var energy = 0L
        for (i in start until end) {
            val sample = samples[i].toLong()
            energy += sample * sample
        }
        return energy < QUIET_RMS.toLong() * QUIET_RMS * (end - start)
    }

    var start = 0
    var end = samples.size
    // Scan only the ends and keep a quarter-second on each side of speech.
    while (start + WINDOW <= end && quiet(start, start + WINDOW)) start += WINDOW
    while (end - WINDOW >= start && quiet(end - WINDOW, end)) end -= WINDOW
    if (end - start < WINDOW) return samples
    start = (start - EDGE_PADDING).coerceAtLeast(0)
    end = (end + EDGE_PADDING).coerceAtMost(samples.size)
    if (end - start < SPEECH_SAMPLE_RATE / 2 || end - start == samples.size) return samples
    return samples.copyOfRange(start, end)
}

internal fun speechWav(samples: ShortArray): ByteArray {
    val size = samples.size * Short.SIZE_BYTES
    return ByteBuffer.allocate(44 + size).order(ByteOrder.LITTLE_ENDIAN).apply {
        put("RIFF".toByteArray(Charsets.US_ASCII))
        putInt(36 + size)
        put("WAVEfmt ".toByteArray(Charsets.US_ASCII))
        putInt(16)
        putShort(1)
        putShort(1)
        putInt(SPEECH_SAMPLE_RATE)
        putInt(SPEECH_SAMPLE_RATE * Short.SIZE_BYTES)
        putShort(2)
        putShort(16)
        put("data".toByteArray(Charsets.US_ASCII))
        putInt(size)
        asShortBuffer().put(samples)
    }.array()
}

