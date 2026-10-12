package es.spainassist.firma.android

import android.app.Application
import android.content.Intent
import android.os.Build
import android.provider.Settings
import android.util.Log
import androidx.compose.runtime.Composable
import es.spainassist.firma.BuildConfig
import es.spainassist.firma.android.nfc.AndroidCardReader
import es.spainassist.firma.app.FirmaController
import es.spainassist.firma.app.Platform
import es.spainassist.firma.relay.RelayEvents
import es.spainassist.firma.relay.RelaySocket
import es.spainassist.firma.relay.RelayTransport
import io.ktor.client.HttpClient
import io.ktor.client.engine.okhttp.OkHttp
import io.ktor.client.plugins.websocket.WebSockets
import kotlinx.coroutines.MainScope
import java.util.concurrent.TimeUnit

/** The app process: one platform and one controller, alive across activity restarts. */
class FirmaApplication : Application() {
    lateinit var platform: AndroidPlatform
        private set
    lateinit var controller: FirmaController
        private set

    override fun onCreate() {
        super.onCreate()
        platform = AndroidPlatform(this)
        // The main thread is the controller's serial scope; card I/O goes to IO threads.
        controller = FirmaController(platform, MainScope())
    }
}

class AndroidPlatform(private val app: Application) : Platform {
    override val appVersion: String = BuildConfig.VERSION_NAME
    override val deviceName: String = Build.MODEL.ifBlank { Build.DEVICE }.take(80)
    override val platformName = "android"
    override val allowInsecureRelay = BuildConfig.DEBUG
    override val store = KeystoreStore(app)
    override val cardReader = AndroidCardReader(app)
    private val scope = MainScope()

    private val client = HttpClient(OkHttp) {
        engine {
            config {
                // Transport-level keepalive, besides the relay's own ping/pong.
                pingInterval(15, TimeUnit.SECONDS)
                connectTimeout(15, TimeUnit.SECONDS)
            }
        }
        install(WebSockets)
    }

    override fun relay(relayUrl: String, room: String, events: RelayEvents): RelayTransport =
        RelaySocket(client, relayUrl, room, scope, events)

    override fun now(): Long = System.currentTimeMillis()

    override fun openNfcSettings() {
        app.startActivity(Intent(Settings.ACTION_NFC_SETTINGS).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK))
    }

    override fun log(message: String) {
        // Never documents, PINs or the CAN: the shared code logs outcomes only.
        Log.i("Firma", message)
    }

    @Composable
    override fun QrScanner(onCode: (String) -> Unit) = es.spainassist.firma.android.QrScanner(onCode)

    @Composable
    override fun PdfPreview(pdf: ByteArray) = es.spainassist.firma.android.PdfPreview(pdf)

    override val licenses = ANDROID_LICENSES

    override fun bundledNotices() = googleNotices(app.assets)

    @Composable
    override fun BackHandler(onBack: () -> Unit) = androidx.activity.compose.BackHandler(onBack = onBack)
}
