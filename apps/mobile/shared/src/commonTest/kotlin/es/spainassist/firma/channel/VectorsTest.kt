package es.spainassist.firma.channel

import es.spainassist.firma.VECTORS_JSON
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.int
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import kotlin.test.Test
import kotlin.test.assertContentEquals
import kotlin.test.assertEquals
import kotlin.test.assertFailsWith
import kotlin.test.assertNull

/** The channel must produce exactly the bytes of the TypeScript implementation. */
class VectorsTest {
    private val v: JsonObject = Json.parseToJsonElement(VECTORS_JSON).jsonObject

    private fun hex(name: String): ByteArray = v.getValue(name).jsonPrimitive.content.hexToBytes()

    private fun JsonObject.hex(name: String): ByteArray = getValue(name).jsonPrimitive.content.hexToBytes()

    @Test
    fun hkdf() {
        val c = v.getValue("hkdf").jsonObject
        val okm = Crypto.hkdfSha256(c.hex("ikm"), c.hex("salt"), c.hex("info"), c.getValue("length").jsonPrimitive.int)
        assertEquals(c.getValue("okm").jsonPrimitive.content, okm.toHex())
    }

    @Test
    fun keysAndFrames() {
        val phone = Crypto.keyPairFrom(hex("phonePrivateKey"), hex("phonePublicKey"))
        val shared = Crypto.ecdh(phone, hex("desktopPublicKey"))
        assertContentEquals(hex("sharedSecret"), shared)
        val keys = deriveSessionKeys(
            shared = shared,
            secret = hex("secret"),
            desktopKey = hex("desktopPublicKey"),
            phoneKey = hex("phonePublicKey"),
            desktopNonce = hex("desktopNonce"),
            phoneNonce = hex("phoneNonce"),
        )
        assertContentEquals(hex("desktopToPhoneKey"), keys.desktopToPhone)
        assertContentEquals(hex("phoneToDesktopKey"), keys.phoneToDesktop)

        assertEquals(Frame.CHALLENGE, hex("challengeFrame")[0])
        val sealer = Sealer(keys.phoneToDesktop, Direction.PhoneToDesktop)
        val prefix = byteArrayOf(Frame.HELLO) + hex("phonePublicKey") + hex("phoneNonce") + hex("desktopNonce")
        assertContentEquals(hex("helloFrame"), sealer.seal(prefix, hex("helloPlaintext")))
        val phoneRecord = v.getValue("phoneRecord").jsonObject
        assertContentEquals(phoneRecord.hex("frame"), sealer.seal(byteArrayOf(Frame.RECORD), phoneRecord.hex("plaintext")))

        val opener = Opener(keys.desktopToPhone, Direction.DesktopToPhone)
        assertContentEquals(hex("welcomePlaintext"), opener.open(hex("welcomeFrame"), 1))
        val assembler = MessageAssembler()
        val records = v.getValue("desktopRecords").jsonArray.map { it.jsonObject }
        val first = opener.open(records[0].hex("frame"), 1)
        assertContentEquals(records[0].hex("plaintext"), first)
        assertNull(assembler.push(first))
        val message = assembler.push(opener.open(records[1].hex("frame"), 1))
        assertEquals(
            """{"type":"sign.done","requestId":"6f1c3b9e-2d4a-4f8b-9c1d-5e7a2b3c4d5e"}""",
            message?.decodeToString(),
        )
        // Replays and frames of the other direction never open.
        assertFailsWith<ChannelException> { opener.open(records[1].hex("frame"), 1) }
        assertFailsWith<ChannelException> {
            Opener(keys.desktopToPhone, Direction.PhoneToDesktop).open(hex("welcomeFrame"), 1)
        }
    }

    @Test
    fun link() {
        val text = v.getValue("link").jsonPrimitive.content
        val link = PairingLink.parse(text, allowInsecure = false)
        assertEquals(v.getValue("relayUrl").jsonPrimitive.content, link.relayUrl)
        assertContentEquals(hex("room"), link.room)
        assertContentEquals(hex("secret"), link.secret)
        assertContentEquals(hex("desktopPublicKey"), link.desktopKey)
        assertEquals(text.substringAfter('#'), link.encode())
        assertEquals(link, PairingLink.parse("sa-firma://pair?d=${link.encode()}", allowInsecure = false))
        assertFailsWith<ChannelException> { PairingLink.parse("https://example.com/p#abc", false) }
        assertFailsWith<ChannelException> { PairingLink.parse("https://example.com/p", false) }
    }
}
