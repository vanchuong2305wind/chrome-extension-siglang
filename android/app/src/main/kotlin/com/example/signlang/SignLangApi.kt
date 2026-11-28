package com.example.signlang

import android.content.Context
import android.graphics.Bitmap
import android.net.ConnectivityManager
import android.net.Network
import android.net.NetworkCapabilities
import android.os.SystemClock
import android.util.Base64
import org.json.JSONArray
import org.json.JSONObject
import java.io.ByteArrayOutputStream
import java.io.IOException
import java.net.ConnectException
import java.net.NoRouteToHostException
import java.net.URI
import java.net.UnknownHostException
import javax.net.ssl.HttpsURLConnection

private const val DEFAULT_SERVER = "https://dutai-gpu.taila6b408.ts.net"
private const val MAX_RESPONSE_BYTES = 12 * 1024 * 1024
private const val FRAME_SIDE = 224
private const val FRAME_PIXELS = FRAME_SIDE * FRAME_SIDE
private const val FRAMES = 16

internal class SignLangApi(context: Context) {
    private val prefs = context.getSharedPreferences("signlang_api", Context.MODE_PRIVATE)
    private val connectivity = context.getSystemService(ConnectivityManager::class.java)
    private data class ConnectionFailure(val origin: String, val network: Network, val until: Long)
    @Volatile private var failed: ConnectionFailure? = null

    var server: String
        get() = prefs.getString("server", DEFAULT_SERVER) ?: DEFAULT_SERVER
        set(value) {
            val text = value.trim()
            val origin = if (text.isEmpty()) "" else {
                val uri = URI(text)
                require(uri.scheme == "https" && uri.host != null && uri.userInfo == null &&
                    uri.query == null && uri.fragment == null && uri.path in listOf("", "/") &&
                    uri.port in -1..65535 && uri.port != 0)
                "https://${uri.rawAuthority}"
            }
            prefs.edit().putString("server", origin).apply()
            failed = null
        }

    fun speechOffline(): Boolean =
        server.isEmpty() || connectivity.getNetworkCapabilities(connectivity.activeNetwork)
            ?.hasCapability(NetworkCapabilities.NET_CAPABILITY_INTERNET) != true

    fun speech(samples: ShortArray): String? {
        if (speechOffline()) return null
        val started = SystemClock.elapsedRealtime()
        val text = call("/api/speech/transcribe?lang=vi", "audio/wav", { speechWav(samples) }) {
            it.getString("text").trim()
        }
        android.util.Log.d("SignLangSpeech", "API round trip ms=${SystemClock.elapsedRealtime() - started}; response=${text != null}")
        if (text == null && server.isNotEmpty() &&
            connectivity.getNetworkCapabilities(connectivity.activeNetwork)
                ?.hasCapability(NetworkCapabilities.NET_CAPABILITY_VALIDATED) == true
        ) {
            throw IOException("Máy chủ nhận dạng chưa phản hồi. Hãy thử lại.")
        }
        return text
    }

    fun textSigns(text: String): String? =
        post("/api/text-to-signs", { JSONObject().put("text", text) }) {
            it.getJSONArray("signs").toString()
        }

    fun sentence(words: List<*>): String? {
        if (words.size !in 1..50) return null
        return post("/api/camera/build-sentence", { JSONObject().put("words", JSONArray(words)) }) {
            val sentence = it.getString("sentence").trim()
            sentence.takeIf(String::isNotEmpty)
        }
    }

    fun landmark(gloss: String): ByteArray? =
        call("/api/landmarks/$gloss") { objectValue ->
            val data = objectValue.getJSONObject("data")
            check(data.getJSONArray("frames").length() > 0)
            data.toString().toByteArray(Charsets.UTF_8)
        }

    fun recognize(encodedRgb: String): JSONObject? =
        post("/api/camera/recognize", {
            JSONObject().put("frames", jpegFrames(encodedRgb)).put("top_k", 2)
        }) { response ->
            val top = response.getJSONObject("prediction")
            val confidence = top.getDouble("confidence")
            val runnerUp = response.getJSONArray("alternatives").getJSONObject(0).getDouble("confidence")
            require(confidence in 0.0..1.0 && runnerUp in 0.0..confidence)
            val word = top.optString("vietnamese").ifBlank { top.getString("label") }
            JSONObject().put("word", word.replace('_', ' ').trim())
                .put("confidence", confidence).put("margin", confidence - runnerUp)
        }

    private fun <T> post(path: String, body: () -> JSONObject, parse: (JSONObject) -> T): T? =
        call(path, "application/json", { body().toString().toByteArray(Charsets.UTF_8) }, parse)

    private fun <T> call(
        path: String,
        contentType: String = "",
        payload: (() -> ByteArray)? = null,
        parse: (JSONObject) -> T,
    ): T? {
        val origin = server
        val network = connectivity.activeNetwork
        if (origin.isEmpty() || network == null ||
            connectivity.getNetworkCapabilities(network)?.hasCapability(NetworkCapabilities.NET_CAPABILITY_INTERNET) != true
        ) return null
        val recentFailure = failed
        if (recentFailure?.origin == origin && recentFailure.network == network &&
            SystemClock.elapsedRealtime() < recentFailure.until
        ) return null
        try {
            val connection = URI(origin + path).toURL().openConnection() as HttpsURLConnection
            try {
                connection.connectTimeout = 2500
                connection.readTimeout = if (path.startsWith("/api/speech/")) 15000 else 5500
                connection.instanceFollowRedirects = false
                connection.setRequestProperty("Accept", "application/json")
                if (payload != null) {
                    val bytes = payload()
                    connection.requestMethod = "POST"
                    connection.doOutput = true
                    connection.setRequestProperty("Content-Type", contentType)
                    connection.setFixedLengthStreamingMode(bytes.size)
                    connection.outputStream.use { it.write(bytes) }
                }
                val status = connection.responseCode
                if (status !in 200..299) return null
                val body = connection.inputStream.use { input ->
                    val output = ByteArrayOutputStream()
                    val buffer = ByteArray(8192)
                    while (true) {
                        val size = input.read(buffer)
                        if (size < 0) break
                        if (output.size() + size > MAX_RESPONSE_BYTES) throw IOException("API response too large")
                        output.write(buffer, 0, size)
                    }
                    output.toString("UTF-8")
                }
                return parse(JSONObject(body))
            } finally {
                connection.disconnect()
            }
        } catch (error: Exception) {
            if (server == origin &&
                (error is ConnectException || error is UnknownHostException || error is NoRouteToHostException)
            ) {
                failed = ConnectionFailure(origin, network, SystemClock.elapsedRealtime() + 8000)
            }
        }
        return null
    }

    private fun jpegFrames(encoded: String): JSONArray {
        val plane = FRAME_PIXELS * FRAMES
        require(encoded.length == 4 * plane)
        val rgb = Base64.decode(encoded, Base64.NO_WRAP)
        require(rgb.size == 3 * plane)
        val pixels = IntArray(FRAME_PIXELS)
        val bitmap = Bitmap.createBitmap(FRAME_SIDE, FRAME_SIDE, Bitmap.Config.ARGB_8888)
        val frames = JSONArray()
        try {
            repeat(FRAMES) { frame ->
                for (pixel in pixels.indices) {
                    val i = frame * FRAME_PIXELS + pixel
                    val red = rgb[i].toInt() and 255
                    val green = rgb[i + plane].toInt() and 255
                    val blue = rgb[i + 2 * plane].toInt() and 255
                    pixels[pixel] = 0xff000000.toInt() or (red shl 16) or (green shl 8) or blue
                }
                bitmap.setPixels(pixels, 0, FRAME_SIDE, 0, 0, FRAME_SIDE, FRAME_SIDE)
                val jpeg = ByteArrayOutputStream()
                check(bitmap.compress(Bitmap.CompressFormat.JPEG, 68, jpeg))
                frames.put(Base64.encodeToString(jpeg.toByteArray(), Base64.NO_WRAP))
            }
        } finally {
            bitmap.recycle()
        }
        return frames
    }
}

