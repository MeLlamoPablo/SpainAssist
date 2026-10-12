package es.spainassist.firma.relay

import es.spainassist.firma.channel.ChannelException
import es.spainassist.firma.channel.Crypto
import es.spainassist.firma.channel.Direction
import es.spainassist.firma.channel.Frame
import es.spainassist.firma.channel.MessageAssembler
import es.spainassist.firma.channel.NONCE_BYTES
import es.spainassist.firma.channel.Opener
import es.spainassist.firma.channel.PairingLink
import es.spainassist.firma.channel.Sealer
import es.spainassist.firma.channel.deriveSessionKeys
import es.spainassist.firma.channel.parseSingleRecord
import es.spainassist.firma.channel.sealMessage
import es.spainassist.firma.channel.singleRecord
import es.spainassist.firma.protocol.COMPANION_PROTOCOL
import es.spainassist.firma.protocol.CompanionJson
import es.spainassist.firma.protocol.DesktopBye
import es.spainassist.firma.protocol.DesktopToPhone
import es.spainassist.firma.protocol.Hello
import es.spainassist.firma.protocol.PhoneBye
import es.spainassist.firma.protocol.PhoneToDesktop
import es.spainassist.firma.protocol.Welcome

sealed interface LinkStatus {
    data object Connecting : LinkStatus

    /** Connected to the relay; the desktop app isn't (closed, asleep, offline). */
    data object DesktopAway : LinkStatus

    data class Connected(val welcome: Welcome) : LinkStatus

    /** The desktop speaks another protocol version: one of the apps needs an update. */
    data class Outdated(val desktopProtocol: Int) : LinkStatus

    data class Ended(val reason: Reason) : LinkStatus {
        enum class Reason { NotFound, Expired, Replaced, DesktopUnpaired, Unpaired }
    }
}

interface LinkListener {
    fun onStatus(status: LinkStatus)

    fun onMessage(message: DesktopToPhone)

    /** A new session started: send again what the desktop may have missed. */
    fun onSession()
}

/**
 * The phone's side of a pairing (packages/companion/src/phone.ts): answers each CHALLENGE with
 * a fresh key and nonce, opens WELCOME, then carries messages. Every reconnect (either side)
 * means a new handshake. Not thread-safe: call it, and let the transport call back, on one
 * serial dispatcher.
 */
class PhoneLink(
    val pairing: PairingLink,
    private val hello: Hello,
    transport: (RelayEvents) -> RelayTransport,
    private val listener: LinkListener,
    private val log: (String) -> Unit = {},
) {
    private class Pending(val sealer: Sealer, val opener: Opener)

    private class Session(val sealer: Sealer, val opener: Opener, val assembler: MessageAssembler)

    private val socket = transport(RelayEvents(::onRelayState, ::onFrame))
    private var pending: Pending? = null
    private var session: Session? = null
    var status: LinkStatus = LinkStatus.Connecting
        private set

    val connected: Boolean get() = session != null

    fun start() = socket.start()

    /** Stops without ending the pairing (the app goes away; it reconnects next time). */
    fun close() {
        session = null
        pending = null
        socket.stop()
    }

    /** Ends the pairing on both sides. */
    fun unpair() {
        send(PhoneBye)
        finish(LinkStatus.Ended(LinkStatus.Ended.Reason.Unpaired))
    }

    fun send(message: PhoneToDesktop): Boolean {
        val s = session ?: return false
        val json = CompanionJson.encodeToString(PhoneToDesktop.serializer(), message).encodeToByteArray()
        for (frame in sealMessage(s.sealer, json)) {
            if (!socket.send(frame)) return false
        }
        return true
    }

    private fun setStatus(next: LinkStatus) {
        if (status == next) return
        status = next
        listener.onStatus(next)
    }

    private fun finish(next: LinkStatus) {
        session = null
        pending = null
        setStatus(next)
        socket.stop()
    }

    private fun onRelayState(state: RelayState) {
        if (status is LinkStatus.Ended) return
        session = null
        pending = null
        when (state) {
            is RelayState.Closed -> finish(
                LinkStatus.Ended(
                    when (state.reason) {
                        RelayState.Closed.Reason.NotFound -> LinkStatus.Ended.Reason.NotFound
                        RelayState.Closed.Reason.Expired -> LinkStatus.Ended.Reason.Expired
                        RelayState.Closed.Reason.Replaced -> LinkStatus.Ended.Reason.Replaced
                    },
                ),
            )
            RelayState.Connecting -> setStatus(LinkStatus.Connecting)
            // With the desktop there, wait for its CHALLENGE.
            is RelayState.Open -> if (!state.peer) setStatus(LinkStatus.DesktopAway)
        }
    }

    private fun onFrame(frame: ByteArray) {
        if (frame.isEmpty() || status is LinkStatus.Ended) return
        try {
            when (frame[0]) {
                Frame.CHALLENGE -> onChallenge(frame)
                Frame.WELCOME -> onWelcome(frame)
                Frame.RECORD -> onRecord(frame)
            }
        } catch (e: ChannelException) {
            log("companion frame rejected: ${e.message}")
            // A broken session: the desktop's next CHALLENGE starts a new one.
            session = null
        } catch (e: IllegalArgumentException) {
            // kotlinx.serialization: a message we can't read. Its message quotes the decrypted
            // input (CAN, PIN, document data), so only the class name goes to the log.
            log("companion message rejected: ${e::class.simpleName}")
        }
    }

    private fun onChallenge(frame: ByteArray) {
        if (frame.size != 1 + NONCE_BYTES) throw ChannelException("Bad challenge")
        val desktopNonce = frame.copyOfRange(1, frame.size)
        val mine = Crypto.generateKeyPair()
        val phoneNonce = Crypto.randomBytes(NONCE_BYTES)
        val keys = deriveSessionKeys(
            shared = Crypto.ecdh(mine, pairing.desktopKey),
            secret = pairing.secret,
            desktopKey = pairing.desktopKey,
            phoneKey = mine.publicKey,
            desktopNonce = desktopNonce,
            phoneNonce = phoneNonce,
        )
        val sealer = Sealer(keys.phoneToDesktop, Direction.PhoneToDesktop)
        val prefix = byteArrayOf(Frame.HELLO) + mine.publicKey + phoneNonce + desktopNonce
        val json = CompanionJson.encodeToString(Hello.serializer(), hello).encodeToByteArray()
        session = null
        pending = Pending(sealer, Opener(keys.desktopToPhone, Direction.DesktopToPhone))
        socket.send(sealer.seal(prefix, singleRecord(json)))
    }

    private fun onWelcome(frame: ByteArray) {
        val p = pending ?: throw ChannelException("Unexpected welcome")
        val json = parseSingleRecord(p.opener.open(frame, 1)).decodeToString()
        val welcome = CompanionJson.decodeFromString(Welcome.serializer(), json)
        if (welcome.type != "welcome") throw ChannelException("Bad welcome")
        pending = null
        if (welcome.protocol != COMPANION_PROTOCOL) {
            setStatus(LinkStatus.Outdated(welcome.protocol))
            return
        }
        session = Session(p.sealer, p.opener, MessageAssembler())
        setStatus(LinkStatus.Connected(welcome))
        listener.onSession()
    }

    private fun onRecord(frame: ByteArray) {
        val s = session ?: throw ChannelException("No session")
        val bytes = s.assembler.push(s.opener.open(frame, 1)) ?: return
        val message = CompanionJson.decodeFromString(DesktopToPhone.serializer(), bytes.decodeToString())
        if (message == DesktopBye) {
            finish(LinkStatus.Ended(LinkStatus.Ended.Reason.DesktopUnpaired))
            return
        }
        listener.onMessage(message)
    }
}
