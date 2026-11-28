package com.example.signlang

import android.Manifest
import android.content.Intent
import android.content.pm.PackageManager
import android.net.Uri
import android.provider.Settings
import io.flutter.embedding.android.FlutterActivity
import io.flutter.embedding.engine.FlutterEngine
import io.flutter.plugin.common.MethodCall
import io.flutter.plugin.common.MethodChannel
import io.flutter.plugin.common.StandardMessageCodec
import io.flutter.plugin.platform.PlatformViewFactory
import org.json.JSONArray
import org.json.JSONObject
import java.util.concurrent.Executors
import java.util.concurrent.atomic.AtomicBoolean

class MainActivity : FlutterActivity() {
    private lateinit var channel: MethodChannel
    private val views = mutableMapOf<String, OfflineWebView>()
    private val speechWorker = Executors.newSingleThreadExecutor()
    private val whisper by lazy { WhisperSession(applicationContext) }
    private val cameraWorker = Executors.newSingleThreadExecutor()
    private val apiWorker = Executors.newSingleThreadExecutor()
    internal val api by lazy { SignLangApi(applicationContext) }
    private val cameraBusy = AtomicBoolean()
    private val classifier by lazy { VslClassifier(applicationContext) }
    private var audio: AudioCapture? = null
    private var transcribing = false
    private var pendingMic: MethodChannel.Result? = null
    private var requestedCamera: OfflineWebView? = null

    override fun configureFlutterEngine(flutterEngine: FlutterEngine) {
        super.configureFlutterEngine(flutterEngine)
        channel = MethodChannel(flutterEngine.dartExecutor.binaryMessenger, "signlang/offline")
        channel.setMethodCallHandler(::onCall)
        for (kind in listOf("avatar", "camera")) {
            flutterEngine.platformViewsController.registry.registerViewFactory(
                "signlang/$kind",
                object : PlatformViewFactory(StandardMessageCodec.INSTANCE) {
                    override fun create(context: android.content.Context, viewId: Int, args: Any?) =
                        OfflineWebView(this@MainActivity, kind).also { views[kind] = it }
                },
            )
        }
    }

    internal fun emit(kind: String, event: String, value: Any?) {
        if (::channel.isInitialized && !isDestroyed) {
            channel.invokeMethod("event", mapOf("kind" to kind, "event" to event, "value" to value))
        }
    }

    internal fun releaseView(view: OfflineWebView) {
        if (views[view.kind] === view) views.remove(view.kind)
        if (requestedCamera === view) requestedCamera = null
    }

    private fun onCall(call: MethodCall, result: MethodChannel.Result) {
        when (call.method) {
            "dictionary" -> {
                try {
                    result.success(assets.open("signs/dictionary.json").bufferedReader().use { it.readText() })
                } catch (_: Exception) {
                    result.error("dictionary", "Không đọc được từ điển ký hiệu.", null)
                }
            }
            "normalize" -> result.success(java.text.Normalizer.normalize(
                call.arguments as String, java.text.Normalizer.Form.NFC,
            ))
            "apiServer" -> result.success(api.server)
            "setApiServer" -> {
                try {
                    api.server = call.arguments as String
                    result.success(null)
                } catch (_: Exception) {
                    result.error("url", "Nhập URL HTTPS của máy chủ SignLang.", null)
                }
            }
            "apiTextSigns" -> requestApi(result) { api.textSigns(call.arguments as String) }
            "apiSentence" -> requestApi(result) { api.sentence(call.arguments as List<*>) }
            "micStart" -> requestMic(result)
            "micStop" -> transcribe(result)
            "micCancel" -> {
                cancelMic()
                speechWorker.execute { whisper.close() }
                result.success(null)
            }
            "play" -> {
                val view = views["avatar"]
                if (view == null || !view.ready) {
                    result.error("avatar", "Avatar đang tải. Hãy thử phát lại sau.", null)
                } else {
                    val signs = JSONArray(call.arguments as List<*>)
                    view.evaluate("window.playSigns?.($signs);")
                    result.success(null)
                }
            }
            "stop" -> {
                views["avatar"]?.evaluate("window.stopSigns?.();")
                result.success(null)
            }
            "reloadAvatar" -> {
                views["avatar"]?.reload()
                result.success(null)
            }
            "cameraStart" -> {
                startCamera()
                result.success(null)
            }
            "cameraStop" -> {
                requestedCamera = null
                views["camera"]?.evaluate("window.stopCamera?.();")
                result.success(null)
            }
            "cameraSwitch" -> {
                views["camera"]?.evaluate("window.switchCamera?.();")
                result.success(null)
            }
            "settings" -> {
                startActivity(Intent(Settings.ACTION_APPLICATION_DETAILS_SETTINGS, Uri.parse("package:$packageName")))
                result.success(null)
            }
            else -> result.notImplemented()
        }
    }

    private fun requestApi(result: MethodChannel.Result, request: () -> String?) {
        apiWorker.execute {
            val response = request()
            runOnUiThread { if (!isDestroyed) result.success(response) }
        }
    }

    private fun requestMic(result: MethodChannel.Result) {
        if (pendingMic != null || audio != null || transcribing) {
            result.error("busy", "Mic đang bận. Hãy thử lại.", null)
            return
        }
        if (checkSelfPermission(Manifest.permission.RECORD_AUDIO) == PackageManager.PERMISSION_GRANTED) {
            openMic(result)
        } else {
            pendingMic = result
            requestPermissions(arrayOf(Manifest.permission.RECORD_AUDIO), 1)
        }
    }

    private fun openMic(result: MethodChannel.Result) {
        try {
            audio = AudioCapture.open {
                runOnUiThread { emit("speech", "status", "Bản ghi đã dừng. Bấm Nhận dạng để tiếp tục.") }
            }
            speechWorker.execute {
                runCatching {
                    if (api.speechOffline()) whisper.prepare()
                }
            }
            result.success(null)
        } catch (error: Exception) {
            result.error("mic", error.message ?: "Không mở được mic.", null)
        }
    }

    private fun transcribe(result: MethodChannel.Result) {
        val capture = audio
        if (capture == null) {
            result.error("mic", "Hãy bắt đầu một bản ghi mới.", null)
            return
        }
        audio = null
        transcribing = true
        speechWorker.execute {
            val recognized = runCatching {
                val recorded = capture.finish()
                val samples = trimQuietEdges(recorded)
                android.util.Log.d("SignLangSpeech", "PCM samples=${recorded.size}, after trim=${samples.size}")
                api.speech(samples)?.let { return@runCatching it }
                runOnUiThread { emit("speech", "status", "Đang nhận dạng giọng nói trên thiết bị…") }
                whisper.transcribe(samples)
            }
            runOnUiThread {
                transcribing = false
                if (!isDestroyed) recognized.fold(result::success) {
                    result.error("speech", it.message ?: "Không nhận dạng được bản ghi.", null)
                }
            }
        }
    }

    private fun cancelMic() {
        audio?.cancel()
        audio = null
        pendingMic?.error("cancelled", "Đã hủy ghi âm.", null)
        pendingMic = null
    }

    private fun startCamera() {
        val view = views["camera"]
        if (view == null || !view.ready) {
            emit("camera", "active", false)
            emit("camera", "status", "Camera đang khởi tạo. Hãy thử lại.")
            return
        }
        if ("vsl224-rgb.onnx" !in (assets.list("models") ?: emptyArray())) {
            emit("camera", "active", false)
            emit("camera", "status", "Bản cài đặt thiếu trọng số nhận diện VSL224.")
            return
        }
        if (checkSelfPermission(Manifest.permission.CAMERA) == PackageManager.PERMISSION_GRANTED) {
            view.evaluate("window.startCamera?.();")
        } else {
            requestedCamera = view
            requestPermissions(arrayOf(Manifest.permission.CAMERA), 2)
        }
    }

    override fun onRequestPermissionsResult(requestCode: Int, permissions: Array<out String>, results: IntArray) {
        super.onRequestPermissionsResult(requestCode, permissions, results)
        val granted = results.firstOrNull() == PackageManager.PERMISSION_GRANTED
        if (requestCode == 1) {
            val result = pendingMic ?: return
            pendingMic = null
            if (granted) openMic(result) else result.error(
                "permission", "Mic chưa được cấp quyền. Hãy thử lại hoặc mở Cài đặt.", null,
            )
        } else if (requestCode == 2) {
            val view = requestedCamera ?: return
            requestedCamera = null
            if (granted) {
                view.evaluate("window.startCamera?.();")
            } else {
                emit("camera", "active", false)
                emit("camera", "permission", false)
                emit("camera", "status", "Camera chưa được cấp quyền. Hãy thử lại hoặc mở Cài đặt.")
            }
        }
    }

    internal fun recognize(encoded: String, callback: (JSONObject) -> Unit) {
        runOnUiThread {
            if (isDestroyed) return@runOnUiThread
            if (!cameraBusy.compareAndSet(false, true)) {
                callback(JSONObject().put("error", "Bộ nhận diện đang bận. Hãy thử lại."))
                return@runOnUiThread
            }
            cameraWorker.execute {
                val output = runCatching {
                    api.recognize(encoded)?.put("online", true) ?: classifier.classify(encoded)
                }.getOrElse {
                    android.util.Log.e("SignLang", "VSL224 inference failed", it)
                    JSONObject().put("error", "Không chạy được model VSL224. Hãy thử lại.")
                }
                runOnUiThread {
                    cameraBusy.set(false)
                    if (!isDestroyed) callback(output)
                }
            }
        }
    }

    override fun onStop() {
        super.onStop()
        val wasRecording = audio != null
        if (wasRecording) {
            audio?.cancel()
            audio = null
            emit("speech", "interrupted", null)
        }
        speechWorker.execute { whisper.close() }
        views["camera"]?.evaluate("window.stopCamera?.();")
    }

    override fun onDestroy() {
        cancelMic()
        speechWorker.execute { whisper.close() }
        speechWorker.shutdown()
        apiWorker.shutdown()
        cameraWorker.execute { classifier.close() }
        cameraWorker.shutdown()
        super.onDestroy()
    }
}

