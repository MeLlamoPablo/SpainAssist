package es.spainassist.firma.relay

import es.spainassist.firma.channel.Base64Std
import es.spainassist.firma.channel.Crypto
import es.spainassist.firma.channel.Direction
import es.spainassist.firma.channel.Frame
import es.spainassist.firma.channel.NONCE_BYTES
import es.spainassist.firma.channel.PUBLIC_KEY_BYTES
import es.spainassist.firma.channel.PairingLink
import es.spainassist.firma.channel.Sealer
import es.spainassist.firma.channel.deriveSessionKeys
import es.spainassist.firma.channel.sealMessage
import es.spainassist.firma.channel.singleRecord
import es.spainassist.firma.protocol.COMPANION_PROTOCOL
import es.spainassist.firma.protocol.CompanionJson
import es.spainassist.firma.protocol.DesktopToPhone
import es.spainassist.firma.protocol.Hello
import es.spainassist.firma.protocol.Welcome
import kotlin.test.Test
import kotlin.test.assertContentEquals
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertIs
import kotlin.test.assertTrue

class PhoneLinkTest {
    @Test
    fun logsRejectedMessagesWithoutTheirContent() {
        val desktop = Crypto.generateKeyPair()
        val secret = ByteArray(32) { 7 }
        val pairing = PairingLink("ws://127.0.0.1:8794", ByteArray(16), secret, desktop.publicKey)
        val sent = ArrayList<ByteArray>()
        var events: RelayEvents? = null
        val statuses = ArrayList<LinkStatus>()
        val messages = ArrayList<DesktopToPhone>()
        val logs = ArrayList<String>()
        val link = PhoneLink(
            pairing,
            Hello(app = "1.0.0", platform = "android", device = "Test phone"),
            transport = { e ->
                events = e
                object : RelayTransport {
                    override fun start() = Unit

                    override fun stop() = Unit

                    override fun send(frame: ByteArray): Boolean = sent.add(frame)
                }
            },
            listener = object : LinkListener {
                override fun onStatus(status: LinkStatus) {
                    statuses += status
                }

                override fun onMessage(message: DesktopToPhone) {
                    messages += message
                }

                override fun onSession() = Unit

                override fun onRoomMissing(): LinkStatus.Ended.Reason? = null
            },
            log = { logs += it },
        )
        val relay = events!!

        // The desktop's side of the handshake.
        val desktopNonce = Crypto.randomBytes(NONCE_BYTES)
        relay.onFrame(byteArrayOf(Frame.CHALLENGE) + desktopNonce)
        val hello = sent.single()
        assertEquals(Frame.HELLO, hello[0])
        val phoneKey = hello.copyOfRange(1, 1 + PUBLIC_KEY_BYTES)
        val phoneNonce = hello.copyOfRange(1 + PUBLIC_KEY_BYTES, 1 + PUBLIC_KEY_BYTES + NONCE_BYTES)
        val keys = deriveSessionKeys(
            shared = Crypto.ecdh(desktop, phoneKey),
            secret = secret,
            desktopKey = desktop.publicKey,
            phoneKey = phoneKey,
            desktopNonce = desktopNonce,
            phoneNonce = phoneNonce,
        )
        val sealer = Sealer(keys.desktopToPhone, Direction.DesktopToPhone)
        val session = ByteArray(32) { 5 }
        val welcome = Welcome(
            "welcome",
            COMPANION_PROTOCOL,
            "0.1.0",
            "2026-10-11T22:00:00.000Z",
            session = Base64Std.encode(session),
        )
        val welcomeJson = CompanionJson.encodeToString(Welcome.serializer(), welcome).encodeToByteArray()
        relay.onFrame(sealer.seal(byteArrayOf(Frame.WELCOME), singleRecord(welcomeJson)))
        assertIs<LinkStatus.Connected>(statuses.last())
        // Later handshakes use the pairing's own secret, which never reaches the log.
        assertContentEquals(session, link.pairing.secret)
        assertFalse(logs.any { it.contains(Base64Std.encode(session)) })

        // A field this build doesn't know: the decoding error quotes the input.
        val json = """{"type":"sign.cancel","requestId":"r1","reason":"cancelled","can":"918273"}"""
        for (frame in sealMessage(sealer, json.encodeToByteArray())) relay.onFrame(frame)
        assertTrue(messages.isEmpty())
        val line = logs.single { it.startsWith("companion message rejected") }
        assertFalse(line.contains("918273"), line)
        assertFalse(line.contains("requestId"), line)
    }

    private class Wired(val link: PhoneLink, val relay: RelayEvents, val statuses: List<LinkStatus>, val stopped: () -> Boolean)

    private fun wire(onRoomMissing: () -> LinkStatus.Ended.Reason?): Wired {
        val desktop = Crypto.generateKeyPair()
        val pairing = PairingLink("ws://127.0.0.1:8794", ByteArray(16), ByteArray(32) { 7 }, desktop.publicKey)
        var events: RelayEvents? = null
        var stopped = false
        val statuses = ArrayList<LinkStatus>()
        val link = PhoneLink(
            pairing,
            Hello(app = "1.0.0", platform = "android", device = "Test phone"),
            transport = { e ->
                events = e
                object : RelayTransport {
                    override fun start() = Unit

                    override fun stop() {
                        stopped = true
                    }

                    override fun send(frame: ByteArray): Boolean = true
                }
            },
            listener = object : LinkListener {
                override fun onStatus(status: LinkStatus) {
                    statuses += status
                }

                override fun onMessage(message: DesktopToPhone) = Unit

                override fun onSession() = Unit

                override fun onRoomMissing() = onRoomMissing()
            },
        )
        return Wired(link, events!!, statuses, { stopped })
    }

    @Test
    fun waitsForAMissingRoomWhileTheListenerKeepsThePairing() {
        var asked = 0
        val w = wire { asked++; null }
        w.link.start()
        w.relay.onState(RelayState.Connecting)
        // The relay restarted and the desktop isn't back: keep trying, quietly.
        w.relay.onState(RelayState.Missing)
        w.relay.onState(RelayState.Connecting)
        w.relay.onState(RelayState.Missing)
        assertEquals(2, asked)
        assertEquals(listOf<LinkStatus>(LinkStatus.RoomMissing), w.statuses)
        assertFalse(w.stopped())
        // The desktop recreated the room.
        w.relay.onState(RelayState.Connecting)
        w.relay.onState(RelayState.Open(peer = false))
        assertEquals(LinkStatus.DesktopAway, w.statuses.last())
    }

    @Test
    fun endsOnAMissingRoomWhenTheListenerGivesUp() {
        val w = wire { LinkStatus.Ended.Reason.Expired }
        w.link.start()
        w.relay.onState(RelayState.Missing)
        assertEquals(LinkStatus.Ended(LinkStatus.Ended.Reason.Expired), w.statuses.last())
        assertTrue(w.stopped())

        // Expired, replaced: final as before, without asking.
        for (reason in listOf(RelayState.Closed.Reason.Expired, RelayState.Closed.Reason.Replaced)) {
            var asked = false
            val other = wire { asked = true; null }
            other.relay.onState(RelayState.Closed(reason))
            assertIs<LinkStatus.Ended>(other.statuses.last())
            assertTrue(other.stopped())
            assertFalse(asked)
        }
    }
}
