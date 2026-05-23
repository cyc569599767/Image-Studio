package top.gptcodex.imagestudio.android

import android.annotation.SuppressLint
import android.os.Bundle
import android.webkit.WebChromeClient
import android.webkit.WebSettings
import android.webkit.WebView
import androidx.appcompat.app.AppCompatActivity

class MainActivity : AppCompatActivity() {
    private lateinit var webView: WebView
    private lateinit var bridge: AndroidImageStudioBridge

    @SuppressLint("SetJavaScriptEnabled")
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        setContentView(R.layout.activity_main)

        webView = findViewById(R.id.webview)
        bridge = AndroidImageStudioBridge(this, webView)

        webView.settings.apply {
            javaScriptEnabled = true
            domStorageEnabled = true
            allowFileAccess = true
            allowContentAccess = true
            mixedContentMode = WebSettings.MIXED_CONTENT_ALWAYS_ALLOW
            useWideViewPort = true
            loadWithOverviewMode = true
            mediaPlaybackRequiresUserGesture = false
        }
        WebView.setWebContentsDebuggingEnabled(true)
        webView.webChromeClient = WebChromeClient()
        webView.addJavascriptInterface(bridge, "AndroidImageStudio")
        webView.loadUrl("file:///android_asset/web/index.html?target=${BuildConfig.TARGET_PLATFORM}")
    }

    override fun onDestroy() {
        webView.removeJavascriptInterface("AndroidImageStudio")
        webView.destroy()
        super.onDestroy()
    }
}
