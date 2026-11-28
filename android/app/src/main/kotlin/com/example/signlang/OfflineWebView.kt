package com.example.signlang

import android.annotation.SuppressLint
import android.content.pm.PackageManager
import android.webkit.JavascriptInterface
import android.webkit.PermissionRequest
import android.webkit.WebChromeClient
import android.webkit.WebResourceRequest
import android.webkit.WebResourceResponse
import android.webkit.WebView
import android.webkit.WebViewClient
import io.flutter.plugin.platform.PlatformView
import org.json.JSONObject
import java.io.ByteArrayInputStream
import java.io.FileNotFoundException
import java.util.zip.GZIPInputStream

internal const val LOCAL_ORIGIN = "https://appassets.androidplatform.net"
private val LANDMARK_PATH = Regex("signs/vsl-[0-9a-f]{20}\\.json")

@SuppressLint("SetJavaScriptEnabled")
internal class OfflineWebView(private val activity: MainActivity, val kind: String) : PlatformView {
    private val web = WebView(activity)
    var ready = false
        private set
    private var disposed = false

    init {
        web.settings.apply {
            javaScriptEnabled = true
            allowFileAccess = false
            allowContentAccess = false
            mediaPlaybackRequiresUserGesture = false
        }
        web.addJavascriptInterface(Bridge(), "SignLang")
        web.webChromeClient = object : WebChromeClient() {
            override fun onPermissionRequest(request: PermissionRequest) {
                val video = PermissionRequest.RESOURCE_VIDEO_CAPTURE
                if (kind == "camera" && request.origin.toString().trimEnd('/') == LOCAL_ORIGIN &&
                    request.resources.contains(video) &&
                    activity.checkSelfPermission(android.Manifest.permission.CAMERA) == PackageManager.PERMISSION_GRANTED
                ) {
                    request.grant(arrayOf(video))
                } else {
                    request.deny()
                }
            }
        }
        web.webViewClient = object : WebViewClient() {
            override fun shouldOverrideUrlLoading(view: WebView, request: WebResourceRequest) = true

            override fun shouldInterceptRequest(view: WebView, request: WebResourceRequest): WebResourceResponse {
                val url = request.url
                if (url.scheme != "https" || url.encodedAuthority != "appassets.androidplatform.net") {
                    return emptyResponse(403, "Forbidden")
                }
                val path = url.path?.removePrefix("/") ?: return emptyResponse(404, "Not Found")
                if (".." in path || path.contains('\\')) return emptyResponse(403, "Forbidden")
                val isLandmark = kind == "avatar" && LANDMARK_PATH.matches(path)
                if (!isLandmark && !path.startsWith("$kind/")) return emptyResponse(403, "Forbidden")
                val mime = when (path.substringAfterLast('.')) {
                    "html" -> "text/html"
                    "js" -> "text/javascript"
                    "json" -> "application/json"
                    else -> "application/octet-stream"
                }
                return try {
                    val input = if (request.method == "HEAD") {
                        activity.assets.open(path).close()
                        ByteArrayInputStream(ByteArray(0))
                    } else if (isLandmark) {
                        val remote = if (url.getQueryParameter("source") == "api") {
                            activity.api.landmark(path.substringAfter('/').removeSuffix(".json"))
                        } else null
                        if (remote == null) GZIPInputStream(activity.assets.open("$path.gzip"))
                        else ByteArrayInputStream(remote)
                    } else {
                        activity.assets.open(path)
                    }
                    WebResourceResponse(mime, if (mime == "application/octet-stream") null else "UTF-8", input)
                } catch (_: FileNotFoundException) {
                    emptyResponse(404, "Not Found")
                } catch (_: java.io.IOException) {
                    emptyResponse(500, "Asset Read Error")
                }
            }
        }
        reload()
    }

    fun reload() {
        ready = false
        web.loadUrl("$LOCAL_ORIGIN/$kind/index.html")
    }

    fun evaluate(script: String) {
        if (!disposed) web.evaluateJavascript(script, null)
    }

    override fun getView() = web

    override fun dispose() {
        disposed = true
        activity.releaseView(this)
        web.removeJavascriptInterface("SignLang")
        web.destroy()
    }

    private fun emptyResponse(code: Int, reason: String) =
        WebResourceResponse("text/plain", "UTF-8", code, reason, emptyMap(), ByteArrayInputStream(ByteArray(0)))

    private inner class Bridge {
        @JavascriptInterface
        fun viewReady() = activity.runOnUiThread {
            if (!disposed) {
                ready = true
                activity.emit(kind, "ready", true)
            }
        }

        @JavascriptInterface
        fun status(message: String) = activity.runOnUiThread {
            if (!disposed) activity.emit(kind, "status", message)
        }

        @JavascriptInterface
        fun cameraState(active: Boolean) = activity.runOnUiThread {
            if (!disposed && kind == "camera") activity.emit(kind, "active", active)
        }

        @JavascriptInterface
        fun prediction(event: String, word: String, confidence: Double, margin: Double) =
            activity.runOnUiThread {
                if (!disposed && kind == "camera") {
                    activity.emit(kind, "prediction", mapOf(
                        "event" to event, "word" to word, "confidence" to confidence, "margin" to margin,
                    ))
                }
            }

        @JavascriptInterface
        fun recognize(run: Int, event: Int, encoded: String) {
            if (kind != "camera") return
            activity.recognize(encoded) { result: JSONObject ->
                evaluate("window.cameraResult?.($run,$event,$result);")
            }
        }
    }
}

