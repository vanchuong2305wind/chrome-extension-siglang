package com.example.signlang

import java.nio.ByteBuffer
import java.nio.ByteOrder
import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Assert.assertSame
import org.junit.Test

class SpeechAudioTest {
    @Test
    fun trimsQuietEndsAndPreservesSpeechInternalPauseAndPadding() {
        val rate = SPEECH_SAMPLE_RATE
        val samples = ShortArray(4 * rate)
        samples.fill(300, rate, rate + rate / 2)
        samples.fill(-300, 2 * rate, 3 * rate)
        val result = trimQuietEdges(samples)
        assertArrayEquals(samples.copyOfRange(3 * rate / 4, 13 * rate / 4), result)
    }

    @Test
    fun preservesAllQuietOrVeryShortSpeech() {
        val quiet = ShortArray(2 * SPEECH_SAMPLE_RATE) { 40 }
        assertSame(quiet, trimQuietEdges(quiet))
        val click = ShortArray(2 * SPEECH_SAMPLE_RATE)
        click[SPEECH_SAMPLE_RATE] = 500
        assertSame(click, trimQuietEdges(click))
    }

    @Test
    fun preservesSpeechAtTheStartAndEnd() {
        val samples = ShortArray(SPEECH_SAMPLE_RATE)
        samples.fill(300, 0, 400)
        samples.fill(-300, samples.size - 400, samples.size)
        assertSame(samples, trimQuietEdges(samples))
    }

    @Test
    fun wavUsesOriginalPcmAndCorrectSizes() {
        val samples = shortArrayOf(Short.MIN_VALUE, -1, 0, 1, Short.MAX_VALUE)
        val wav = speechWav(samples)
        val header = ByteBuffer.wrap(wav).order(ByteOrder.LITTLE_ENDIAN)
        assertEquals("RIFF", String(wav, 0, 4, Charsets.US_ASCII))
        assertEquals("WAVE", String(wav, 8, 4, Charsets.US_ASCII))
        assertEquals(36 + 2 * samples.size, header.getInt(4))
        assertEquals(SPEECH_SAMPLE_RATE, header.getInt(24))
        assertEquals("data", String(wav, 36, 4, Charsets.US_ASCII))
        assertEquals(2 * samples.size, header.getInt(40))
        val pcm = ShortArray(samples.size)
        header.position(44)
        header.asShortBuffer().get(pcm)
        assertArrayEquals(samples, pcm)
    }
}

