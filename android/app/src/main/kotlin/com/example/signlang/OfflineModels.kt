package com.example.signlang

import ai.onnxruntime.OnnxJavaType
import ai.onnxruntime.OnnxTensor
import ai.onnxruntime.OrtEnvironment
import ai.onnxruntime.OrtSession
import android.annotation.SuppressLint
import android.content.Context
import android.media.AudioFormat
import android.media.AudioRecord
import android.media.MediaRecorder
import android.os.SystemClock
import android.util.Base64
import android.util.Log
import org.json.JSONArray
import org.json.JSONObject
import java.io.File
import java.nio.ByteBuffer
import java.util.concurrent.atomic.AtomicBoolean
import kotlin.math.exp

private const val MAX_SAMPLES = 30 * SPEECH_SAMPLE_RATE
private const val RGB_BYTES = 3 * 16 * 224 * 224

internal fun Context.cachedAsset(name: String): File {
    val descriptor = assets.openFd(name)
    val size = descriptor.use { it.length }
    val target = File(cacheDir, "${size}_${name.substringAfterLast('/')}")
    if (target.isFile && target.length() == size) return target
    val download = File.createTempFile("model-", ".tmp", cacheDir)
    try {
        assets.open(name).use { input -> download.outputStream().use { input.copyTo(it) } }
        check(download.length() == size && download.renameTo(target)) { "Không thể lưu model cục bộ." }
        return target
    } finally {
        download.delete()
    }
}

private object Whisper {
    init {
        System.loadLibrary("signlang_whisper")
    }

    external fun open(path: String): Long
    external fun transcribe(handle: Long, samples: ShortArray): ByteArray?
    external fun close(handle: Long)
}

// Owned by the single speech worker. Prepare, transcription and close run in order.
internal class WhisperSession(private val context: Context) : AutoCloseable {
    private var handle = 0L

    fun prepare() {
        if (handle != 0L) return
        val started = SystemClock.elapsedRealtime()
        val model = context.cachedAsset("models/ggml-base-q5_1.bin")
        handle = Whisper.open(model.absolutePath)
        check(handle != 0L) { "Không nạp được model Whisper." }
        Log.d("SignLangSpeech", "Whisper setup ms=${SystemClock.elapsedRealtime() - started}")
    }

    fun transcribe(samples: ShortArray): String {
        prepare()
        val started = SystemClock.elapsedRealtime()
        val output = Whisper.transcribe(handle, samples)
        if (output == null) {
            close()
            error("Whisper không xử lý được bản ghi.")
        }
        Log.d("SignLangSpeech", "Whisper decode ms=${SystemClock.elapsedRealtime() - started}")
        return output.toString(Charsets.UTF_8).trim()
    }

    override fun close() {
        if (handle != 0L) Whisper.close(handle)
        handle = 0L
    }
}

internal class AudioCapture private constructor(
    private val recorder: AudioRecord,
    onComplete: () -> Unit,
) {
    private val stop = AtomicBoolean()
    private val samples = ShortArray(MAX_SAMPLES)
    private var size = 0
    private var failure: Exception? = null
    private val reader = Thread({
        try {
            while (!stop.get() && size < samples.size) {
                val read = recorder.read(samples, size, minOf(SPEECH_SAMPLE_RATE / 25, samples.size - size))
                check(read > 0) { "Không đọc được dữ liệu mic." }
                size += read
            }
        } catch (error: Exception) {
            failure = error
        } finally {
            try {
                recorder.stop()
            } catch (_: IllegalStateException) {
                // A system interruption may have already stopped the recorder.
            } finally {
                recorder.release()
            }
            if (!stop.get()) onComplete()
        }
    }, "signlang-mic").apply { start() }

    fun cancel() {
        stop.set(true)
    }

    fun finish(): ShortArray {
        cancel()
        reader.join()
        failure?.let { throw it }
        check(size >= SPEECH_SAMPLE_RATE / 2) { "Bản ghi quá ngắn. Hãy nói lại." }
        return samples.copyOf(size)
    }

    companion object {
        @SuppressLint("MissingPermission")
        fun open(onComplete: () -> Unit): AudioCapture {
            val channel = AudioFormat.CHANNEL_IN_MONO
            val encoding = AudioFormat.ENCODING_PCM_16BIT
            val minimum = AudioRecord.getMinBufferSize(SPEECH_SAMPLE_RATE, channel, encoding)
            check(minimum > 0) { "Mic không hỗ trợ thu âm 16 kHz." }
            val recorder = AudioRecord(MediaRecorder.AudioSource.MIC, SPEECH_SAMPLE_RATE, channel, encoding,
                maxOf(minimum, SPEECH_SAMPLE_RATE / 2))
            try {
                check(recorder.state == AudioRecord.STATE_INITIALIZED) { "Không khởi tạo được mic." }
                recorder.startRecording()
                check(recorder.recordingState == AudioRecord.RECORDSTATE_RECORDING) {
                    "Mic chưa bắt đầu ghi âm."
                }
                return AudioCapture(recorder, onComplete)
            } catch (error: Exception) {
                recorder.release()
                throw error
            }
        }
    }
}

internal class VslClassifier(private val context: Context) : AutoCloseable {
    private var runner: OrtSession? = null
    private val labels by lazy {
        val json = context.assets.open("models/labels.json").bufferedReader().use { JSONArray(it.readText()) }
        check(json.length() == 224) { "Danh sách nhãn VSL224 không hợp lệ." }
        List(json.length()) { json.getString(it).replace('_', ' ').trim() }
    }

    fun classify(encoded: String): JSONObject {
        require(encoded.length == RGB_BYTES / 3 * 4) { "Sai kích thước clip RGB." }
        val bytes = Base64.decode(encoded, Base64.NO_WRAP)
        require(bytes.size == RGB_BYTES) { "Sai kích thước tensor RGB." }
        val buffer = ByteBuffer.allocateDirect(bytes.size).put(bytes).apply { rewind() }
        val env = OrtEnvironment.getEnvironment()
        val session = runner ?: OrtSession.SessionOptions().use { options ->
            options.setIntraOpNumThreads(4)
            options.setInterOpNumThreads(1)
            val model = context.cachedAsset("models/vsl224-rgb.onnx")
            env.createSession(model.absolutePath, options).also { runner = it }
        }
        val tensor = OnnxTensor.createTensor(env, buffer, longArrayOf(1, 3, 16, 224, 224), OnnxJavaType.UINT8)
        val logits = tensor.use {
            session.run(mapOf("rgb" to it)).use { result ->
                (result[0].value as Array<*>).single() as FloatArray
            }
        }
        check(logits.size == labels.size && logits.all(Float::isFinite))
        val top = logits.indices.sortedByDescending { logits[it] }.take(2)
        val max = logits[top[0]]
        val sum = logits.sumOf { exp((it - max).toDouble()) }
        val first = 1.0 / sum
        val second = exp((logits[top[1]] - max).toDouble()) / sum
        return JSONObject().put("word", labels[top[0]]).put("confidence", first).put("margin", first - second)
    }

    override fun close() {
        runner?.close()
        runner = null
    }
}

