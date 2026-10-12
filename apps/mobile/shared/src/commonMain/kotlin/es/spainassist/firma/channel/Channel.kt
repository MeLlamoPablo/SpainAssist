package es.spainassist.firma.channel

import es.spainassist.firma.protocol.MAX_MESSAGE_BYTES

/**
 * The end-to-end channel (packages/companion/src/channel.ts):
 *
 *   CHALLENGE  0x01 | desktop nonce (16)                                     desktop → phone
 *   HELLO      0x02 | phone key (65) | phone nonce (16) | desktop nonce (16) | seq (8) | sealed
 *   WELCOME    0x03 | seq (8) | sealed                                       desktop → phone
 *   RECORD     0x10 | seq (8) | sealed                                       both ways
 *
 * Keys: HKDF-SHA256(ECDH(phone key, desktop key), salt = link secret, info = "sa-companion v1"
 * | desktop key | phone key | desktop nonce | phone nonce) → desktop→phone key | phone→desktop
 * key. Sealed = AES-256-GCM, nonce = direction (4) | seq (8), AAD = the header. Each direction
 * counts from 0; records carry flags (1) | bytes, flag 0x01 on a message's last fragment.
 */
object Frame {
    const val CHALLENGE: Byte = 0x01
    const val HELLO: Byte = 0x02
    const val WELCOME: Byte = 0x03
    const val RECORD: Byte = 0x10
}

const val NONCE_BYTES = 16
const val FRAGMENT_BYTES = 256 * 1024
private const val TAG_BYTES = 16
private const val LAST: Byte = 0x01
private val INFO = "sa-companion v1".encodeToByteArray()

const val HELLO_PREFIX_BYTES = 1 + PUBLIC_KEY_BYTES + NONCE_BYTES * 2

enum class Direction(internal val prefix: ByteArray) {
    DesktopToPhone(byteArrayOf(0, 0, 0, 1)),
    PhoneToDesktop(byteArrayOf(0, 0, 0, 2)),
}

class SessionKeys(val desktopToPhone: ByteArray, val phoneToDesktop: ByteArray)

fun deriveSessionKeys(
    shared: ByteArray,
    secret: ByteArray,
    desktopKey: ByteArray,
    phoneKey: ByteArray,
    desktopNonce: ByteArray,
    phoneNonce: ByteArray,
): SessionKeys {
    val okm = Crypto.hkdfSha256(shared, secret, INFO + desktopKey + phoneKey + desktopNonce + phoneNonce, 64)
    return SessionKeys(okm.copyOfRange(0, 32), okm.copyOfRange(32, 64))
}

private fun u64(value: Long): ByteArray = ByteArray(8) { (value ushr (56 - 8 * it)).toByte() }

private fun readU64(bytes: ByteArray, at: Int): Long {
    var v = 0L
    for (i in 0 until 8) v = (v shl 8) or (bytes[at + i].toLong() and 0xff)
    return v
}

/** Seals frames in one direction, numbering them from 0. */
class Sealer(private val key: ByteArray, private val direction: Direction) {
    private var seq = 0L

    fun seal(prefix: ByteArray, plaintext: ByteArray): ByteArray {
        val number = seq++
        val header = prefix + u64(number)
        return header + Crypto.aesGcmSeal(key, direction.prefix + u64(number), plaintext, header)
    }
}

/** Opens frames of one direction, in order. Any failure means the session is broken. */
class Opener(private val key: ByteArray, private val direction: Direction) {
    private var seq = 0L

    fun open(frame: ByteArray, prefixLength: Int): ByteArray {
        val headerLength = prefixLength + 8
        if (frame.size < headerLength + TAG_BYTES) throw ChannelException("Short frame")
        val number = readU64(frame, prefixLength)
        if (number != seq) throw ChannelException("Out of order")
        val header = frame.copyOfRange(0, headerLength)
        val plain = Crypto.aesGcmOpen(
            key,
            direction.prefix + u64(number),
            frame.copyOfRange(headerLength, frame.size),
            header,
        )
        seq++
        return plain
    }
}

/** Splits a message (JSON bytes) into RECORD frames. */
fun sealMessage(sealer: Sealer, json: ByteArray): List<ByteArray> {
    if (json.size > MAX_MESSAGE_BYTES) throw ChannelException("Message too large")
    val frames = ArrayList<ByteArray>()
    var at = 0
    do {
        val end = minOf(at + FRAGMENT_BYTES, json.size)
        val last = end >= json.size
        frames += sealer.seal(byteArrayOf(Frame.RECORD), byteArrayOf(if (last) LAST else 0) + json.copyOfRange(at, end))
        at = end
    } while (!last)
    return frames
}

/** Joins the fragments of RECORD frames back into messages (JSON bytes). */
class MessageAssembler {
    private val parts = ArrayList<ByteArray>()
    private var size = 0

    /** The message when `plaintext` was its last fragment. */
    fun push(plaintext: ByteArray): ByteArray? {
        if (plaintext.isEmpty()) throw ChannelException("Empty record")
        size += plaintext.size - 1
        if (size > MAX_MESSAGE_BYTES) throw ChannelException("Message too large")
        parts += plaintext.copyOfRange(1, plaintext.size)
        if (plaintext[0].toInt() and LAST.toInt() == 0) return null
        val out = ByteArray(size)
        var at = 0
        for (part in parts) {
            part.copyInto(out, at)
            at += part.size
        }
        parts.clear()
        size = 0
        return out
    }
}

/** Plaintext of HELLO / WELCOME: one fragment. */
fun singleRecord(json: ByteArray): ByteArray = byteArrayOf(LAST) + json

fun parseSingleRecord(plaintext: ByteArray): ByteArray {
    if (plaintext.isEmpty() || plaintext[0] != LAST) throw ChannelException("Bad handshake")
    return plaintext.copyOfRange(1, plaintext.size)
}
