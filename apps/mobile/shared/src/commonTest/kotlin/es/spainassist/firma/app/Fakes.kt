package es.spainassist.firma.app

import androidx.compose.runtime.Composable
import es.spainassist.firma.card.Card
import es.spainassist.firma.card.CardException
import es.spainassist.firma.card.CardReader
import es.spainassist.firma.card.DnieSession
import es.spainassist.firma.card.NfcAvailability
import es.spainassist.firma.channel.Crypto
import es.spainassist.firma.channel.PairingLink
import es.spainassist.firma.protocol.Algorithm
import es.spainassist.firma.protocol.DesktopToPhone
import es.spainassist.firma.protocol.Hello
import es.spainassist.firma.protocol.PhoneToDesktop
import es.spainassist.firma.relay.LinkListener
import es.spainassist.firma.relay.LinkStatus
import es.spainassist.firma.relay.RelayEvents
import es.spainassist.firma.relay.RelayTransport
import es.spainassist.firma.protocol.Welcome
import kotlinx.coroutines.channels.Channel
import kotlinx.coroutines.flow.MutableStateFlow

class FakeStore : SecureStore {
    val values = HashMap<String, String>()

    override fun get(key: String) = values[key]

    override fun put(key: String, value: String) {
        values[key] = value
    }

    override fun remove(key: String) {
        values.remove(key)
    }
}

class FakeCardReader : CardReader {
    override val nfc = MutableStateFlow(NfcAvailability.Ready)
    private val cards = Channel<Card>(Channel.UNLIMITED)
    var waiting = 0
        private set

    fun present(card: Card) {
        cards.trySend(card)
    }

    override suspend fun awaitCard(): Card {
        waiting++
        try {
            return cards.receive()
        } finally {
            waiting--
        }
    }
}

/** A DNIe: [script] decides what each open/sign does (null = succeed). */
class FakeCard(
    private val certificate: ByteArray = byteArrayOf(1, 2, 3),
    private val onOpen: (can: String) -> CardException? = { null },
    private val onSign: (data: ByteArray, pin: String) -> CardException? = { _, _ -> null },
) : Card {
    val signed = ArrayList<ByteArray>()
    var closed = false
    var purposeRead: es.spainassist.firma.protocol.Purpose? = null
    var digestSigned = false

    override fun open(can: String, purpose: es.spainassist.firma.protocol.Purpose, pin: () -> String): DnieSession {
        purposeRead = purpose
        onOpen(can)?.let { throw it }
        return object : DnieSession {
            override val certificates = listOf(certificate)

            override fun sign(data: ByteArray, algorithm: Algorithm, prehashed: Boolean): ByteArray {
                onSign(data, pin())?.let { throw it }
                signed += data
                digestSigned = prehashed
                return if (prehashed) data else Crypto.digest(algorithm.digest, data)
            }
        }
    }

    override fun close() {
        closed = true
    }
}

class FakeLink(val pairing: PairingLink, val listener: LinkListener) : CompanionLink {
    val sent = ArrayList<PhoneToDesktop>()
    override var connected = false
    var started = 0
    var unpaired = false
    var closed = false

    override fun start() {
        started++
    }

    override fun close() {
        closed = true
    }

    override fun unpair() {
        unpaired = true
    }

    override fun send(message: PhoneToDesktop): Boolean {
        if (!connected) return false
        sent += message
        return true
    }

    fun connect(expiresAt: String = "2026-10-11T22:00:00.000Z", session: String? = null) {
        connected = true
        listener.onStatus(LinkStatus.Connected(Welcome("welcome", 1, "0.1.0", expiresAt, session)))
        listener.onSession()
    }

    fun drop() {
        connected = false
        listener.onStatus(LinkStatus.Connecting)
    }

    /** The relay refused the room (4404), as [es.spainassist.firma.relay.PhoneLink] reports it. */
    fun roomMissing() {
        connected = false
        val end = listener.onRoomMissing()
        if (end != null) {
            closed = true
            listener.onStatus(LinkStatus.Ended(end))
        } else {
            listener.onStatus(LinkStatus.RoomMissing)
        }
    }

    fun deliver(message: DesktopToPhone) = listener.onMessage(message)

    inline fun <reified T : PhoneToDesktop> sentOf(): List<T> = sent.filterIsInstance<T>()
}

class FakePlatform(var clock: Long = 1_791_000_000_000L) : Platform {
    override val appVersion = "1.0.0"
    override val deviceName = "Test phone"
    override val platformName = "android"
    override val allowInsecureRelay = true
    override val store = FakeStore()
    override val cardReader = FakeCardReader()

    override fun relay(relayUrl: String, room: String, events: RelayEvents): RelayTransport =
        error("tests use FakeLink")

    override fun now() = clock

    override fun openNfcSettings() = Unit

    override fun log(area: LogArea, message: String) = Unit

    @Composable
    override fun QrScanner(onCode: (String) -> Unit) = Unit

    @Composable
    override fun PdfPreview(pdf: ByteArray) = Unit

    override val licenses = Licenses(eupl = false, groups = emptyList(), proprietary = emptyList())

    override fun bundledNotices() = emptyList<Pair<String, String>>()

    @Composable
    override fun BackHandler(onBack: () -> Unit) = Unit
}

/** A pairing link to a test relay. */
fun testLink(): String {
    val payload = byteArrayOf(1) + ByteArray(16) { it.toByte() } + ByteArray(32) { 7 } +
        (byteArrayOf(4) + ByteArray(64) { 9 }) + "ws://192.168.1.20:8794".encodeToByteArray()
    return "http://192.168.1.20:8794/p#" + es.spainassist.firma.channel.Base64Url.encode(payload).trimEnd('=')
}

/** Captures the link the controller creates. */
class LinkSpy {
    val links = ArrayList<FakeLink>()
    val hellos = ArrayList<Hello>()
    val factory: LinkFactory = { pairing, hello, listener ->
        hellos += hello
        FakeLink(pairing, listener).also { links += it }
    }
    val last get() = links.last()
}
