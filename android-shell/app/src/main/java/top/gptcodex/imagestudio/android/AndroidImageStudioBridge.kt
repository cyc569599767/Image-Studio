package top.gptcodex.imagestudio.android

import android.content.Context
import android.content.Intent
import android.net.Uri
import android.os.Environment
import android.util.Base64
import android.webkit.JavascriptInterface
import android.webkit.WebView
import androidx.core.content.FileProvider
import org.json.JSONArray
import java.io.File
import java.text.SimpleDateFormat
import java.util.Date
import java.util.Locale

class AndroidImageStudioBridge(
    private val context: Context,
    private val webView: WebView,
) {
    private val prefs = context.getSharedPreferences("image_studio_android", Context.MODE_PRIVATE)
    private val outputDirKey = "output_dir"

    @JavascriptInterface
    fun invoke(requestId: String, method: String, payloadJson: String) {
        try {
            val args = JSONArray(payloadJson)
            val result = when (method) {
                "GetOutputDir" -> getOutputDir()
                "SetOutputDir" -> {
                    setOutputDir(args.optString(0, ""))
                    null
                }
                "ChooseOutputDir" -> getOutputDir()
                "GetStoredAPIKey" -> getStoredApiKey(args.optString(0))
                "SetStoredAPIKey" -> {
                    setStoredApiKey(args.optString(0), args.optString(1))
                    null
                }
                "DeleteStoredAPIKey" -> {
                    deleteStoredApiKey(args.optString(0))
                    null
                }
                "OpenExternalURL" -> {
                    openExternalUrl(args.optString(0))
                    null
                }
                "OpenOutputDir" -> {
                    openOutputDir()
                    null
                }
                "ExportHistoryToFile" -> exportHistory(args.optString(0))
                "SaveImageAs" -> saveImage(args.optString(0), args.optString(1))
                else -> throw UnsupportedOperationException("$method is not implemented in Android shell yet")
            }
            resolve(requestId, result)
        } catch (error: Exception) {
            reject(requestId, error.message ?: error.javaClass.simpleName)
        }
    }

    @JavascriptInterface
    fun getOutputDir(): String {
        return prefs.getString(outputDirKey, defaultOutputDir().absolutePath) ?: defaultOutputDir().absolutePath
    }

    @JavascriptInterface
    fun setOutputDir(path: String) {
        val dir = if (path.isBlank()) defaultOutputDir() else File(path)
        dir.mkdirs()
        prefs.edit().putString(outputDirKey, dir.absolutePath).apply()
    }

    @JavascriptInterface
    fun getStoredApiKey(user: String): String {
        return prefs.getString("apikey_$user", "") ?: ""
    }

    @JavascriptInterface
    fun setStoredApiKey(user: String, value: String) {
        if (value.isBlank()) prefs.edit().remove("apikey_$user").apply()
        else prefs.edit().putString("apikey_$user", value.trim()).apply()
    }

    @JavascriptInterface
    fun deleteStoredApiKey(user: String) {
        prefs.edit().remove("apikey_$user").apply()
    }

    @JavascriptInterface
    fun openOutputDir(): String {
        val dir = File(getOutputDir()).apply { mkdirs() }
        val uri = FileProvider.getUriForFile(context, "${context.packageName}.fileprovider", dir)
        val intent = Intent(Intent.ACTION_VIEW).apply {
            setDataAndType(uri, "*/*")
            addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_GRANT_READ_URI_PERMISSION)
        }
        context.startActivity(intent)
        return dir.absolutePath
    }

    @JavascriptInterface
    fun openExternalUrl(url: String) {
        val intent = Intent(Intent.ACTION_VIEW, Uri.parse(url)).apply {
            addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
        }
        context.startActivity(intent)
    }

    @JavascriptInterface
    fun exportHistory(jsonContent: String): String {
        val file = File(getOutputDir(), "image-studio-history-${timestamp()}.json")
        file.parentFile?.mkdirs()
        file.writeText(jsonContent)
        return file.absolutePath
    }

    @JavascriptInterface
    fun saveImage(imageB64: String, suggestedName: String): String {
        val name = if (suggestedName.endsWith(".png", true)) suggestedName else "$suggestedName.png"
        val file = File(getOutputDir(), name)
        file.parentFile?.mkdirs()
        file.writeBytes(Base64.decode(imageB64, Base64.DEFAULT))
        return file.absolutePath
    }

    private fun defaultOutputDir(): File {
        val pictures = context.getExternalFilesDir(Environment.DIRECTORY_PICTURES)
        return File(pictures ?: context.filesDir, "ImageStudio")
    }

    private fun timestamp(): String = SimpleDateFormat("yyyyMMdd-HHmmss", Locale.US).format(Date())

    private fun resolve(requestId: String, payload: Any?) {
        val serialized = when (payload) {
            null -> "null"
            is String -> org.json.JSONObject.quote(payload)
            is Number, is Boolean -> payload.toString()
            else -> org.json.JSONObject.wrap(payload).toString()
        }
        webView.post {
            webView.evaluateJavascript("window.__imageStudioNativeResolve(${org.json.JSONObject.quote(requestId)}, $serialized)", null)
        }
    }

    private fun reject(requestId: String, message: String) {
        webView.post {
            webView.evaluateJavascript(
                "window.__imageStudioNativeReject(${org.json.JSONObject.quote(requestId)}, ${org.json.JSONObject.quote(message)})",
                null,
            )
        }
    }
}
