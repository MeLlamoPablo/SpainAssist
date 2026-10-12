package es.spainassist.firma.android

import android.content.Intent
import android.os.Bundle
import android.view.WindowManager
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.activity.enableEdgeToEdge
import androidx.lifecycle.Lifecycle
import androidx.lifecycle.lifecycleScope
import androidx.lifecycle.repeatOnLifecycle
import es.spainassist.firma.BuildConfig
import es.spainassist.firma.ui.FirmaApp
import kotlinx.coroutines.launch

class MainActivity : ComponentActivity() {
    private val app get() = application as FirmaApplication

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        enableEdgeToEdge()
        // Documents to sign must not show in the recents screen or in screenshots (debug builds
        // allow screenshots, for development).
        if (!BuildConfig.DEBUG) window.addFlags(WindowManager.LayoutParams.FLAG_SECURE)
        setContent { FirmaApp(app.controller, app.platform) }
        if (savedInstanceState == null) handle(intent)
        lifecycleScope.launch {
            // Reader mode only while the app is in front and waiting for or using the card; the
            // screen stays on meanwhile so the read isn't interrupted.
            repeatOnLifecycle(Lifecycle.State.RESUMED) {
                app.platform.cardReader.refresh()
                app.controller.readingCard.collect { reading ->
                    if (reading) {
                        app.platform.cardReader.attach(this@MainActivity)
                        window.addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON)
                    } else {
                        app.platform.cardReader.detach(this@MainActivity)
                        window.clearFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON)
                    }
                }
            }
        }
    }

    override fun onPause() {
        app.platform.cardReader.detach(this)
        super.onPause()
    }

    override fun onNewIntent(intent: Intent) {
        super.onNewIntent(intent)
        handle(intent)
    }

    /** A pairing link: https://<relay>/p#… (App Links) or sa-firma://pair?d=… (landing page). */
    private fun handle(intent: Intent?) {
        if (intent?.action != Intent.ACTION_VIEW) return
        val data = intent.dataString ?: return
        app.controller.onLink(data)
    }
}
