package es.spainassist.firma.app

import androidx.compose.runtime.Composable
import es.spainassist.firma.card.CardReader
import es.spainassist.firma.relay.RelayEvents
import es.spainassist.firma.relay.RelayTransport

/** Small values kept encrypted by the platform (Android Keystore, iOS Keychain). */
interface SecureStore {
    fun get(key: String): String?

    fun put(key: String, value: String)

    fun remove(key: String)
}

/** What the shared app needs from the platform. */
interface Platform {
    val appVersion: String

    /** Device model shown on the desktop ("Pixel 8"). */
    val deviceName: String

    val platformName: String

    /** Debug builds accept ws:// relays (a relay on the developer's machine). */
    val allowInsecureRelay: Boolean

    val store: SecureStore
    val cardReader: CardReader

    /** A connection to the relay for a room (Android: OkHttp WebSockets). */
    fun relay(relayUrl: String, room: String, events: RelayEvents): RelayTransport

    fun now(): Long

    fun openNfcSettings()

    fun log(message: String)

    /** Camera QR scanner; calls [onCode] with every code it reads. */
    @Composable
    fun QrScanner(onCode: (String) -> Unit)

    /** Renders a PDF (all pages) for review. */
    @Composable
    fun PdfPreview(pdf: ByteArray)

    /** The licences of what this build ships, for the licences screen. */
    val licenses: Licenses

    /**
     * Notices of the open-source code inside the proprietary libraries (name and text), as
     * their vendors ship them. Reads a large file: call it off the main thread.
     */
    fun bundledNotices(): List<Pair<String, String>>

    /** Calls [onBack] instead of leaving the app when the user goes back (Android). */
    @Composable
    fun BackHandler(onBack: () -> Unit)
}
