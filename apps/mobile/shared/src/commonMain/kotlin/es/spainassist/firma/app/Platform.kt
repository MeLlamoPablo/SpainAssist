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

/** Where a debug log line comes from. */
enum class LogArea {
    /** Requests and pairing in [FirmaController]. */
    Flow,

    /** The encrypted channel to the desktop (`PhoneLink`). */
    Link,

    /** The WebSocket to the relay (`RelaySocket`). */
    Relay,

    /** The NFC reader and the card. */
    Nfc,
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

    /**
     * Debug log (Android: logcat tag `Firma/<area>`). Callers log outcomes, ids, codes and
     * exception classes only: never the CAN, the PIN, keys, certificates, data to sign,
     * documents, pairing secrets or personal data.
     */
    fun log(area: LogArea, message: String)

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
