package es.spainassist.firma.channel

/**
 * The pairing link the desktop shows as a QR code (packages/companion/src/link.ts):
 *
 *   https://<relay host>/p#<Base64url payload>
 *
 * Payload: version (1) = 1 | room id (16) | secret (32) | desktop public key (65, P-256
 * uncompressed) | relay base URL (UTF-8, ws:// or wss://). The app also accepts the landing
 * page's `sa-firma://pair?d=<payload>`.
 */
data class PairingLink(
    val relayUrl: String,
    val room: ByteArray,
    val secret: ByteArray,
    val desktopKey: ByteArray,
) {
    /** The room id as the relay knows it (Base64url, 22 characters). */
    val roomId: String get() = Base64Url.encode(room).trimEnd('=')

    /** The payload again, to store the pairing. */
    fun encode(): String {
        val payload = byteArrayOf(LINK_VERSION) + room + secret + desktopKey + relayUrl.encodeToByteArray()
        return Base64Url.encode(payload).trimEnd('=')
    }

    override fun equals(other: Any?): Boolean = other is PairingLink && encode() == other.encode()

    override fun hashCode(): Int = encode().hashCode()

    companion object {
        /**
         * Parses a scanned or opened link. `allowInsecure` accepts ws:// relays (debug builds, a
         * relay on the developer's machine).
         */
        fun parse(text: String, allowInsecure: Boolean): PairingLink {
            val trimmed = text.trim()
            val payload = when {
                trimmed.startsWith("sa-firma://pair") ->
                    trimmed.substringAfter("?").split("&")
                        .firstOrNull { it.startsWith("d=") }?.removePrefix("d=")
                trimmed.startsWith("https://") || trimmed.startsWith("http://") ->
                    trimmed.substringAfter('#', "").ifEmpty { null }
                else -> null
            } ?: throw ChannelException("Not a pairing link")
            return decode(payload, allowInsecure)
        }

        fun decode(payload: String, allowInsecure: Boolean): PairingLink {
            if (!payload.all { it.isLetterOrDigit() || it == '-' || it == '_' }) {
                throw ChannelException("Not a pairing link")
            }
            val bytes = try {
                Base64Url.decode(payload)
            } catch (e: IllegalArgumentException) {
                throw ChannelException("Not a pairing link")
            }
            if (bytes.size <= FIXED || bytes.size > FIXED + 512 || bytes[0] != LINK_VERSION) {
                throw ChannelException("Not a pairing link")
            }
            var at = 1
            fun take(n: Int) = bytes.copyOfRange(at, at + n).also { at += n }
            val room = take(ROOM_BYTES)
            val secret = take(SECRET_BYTES)
            val desktopKey = take(PUBLIC_KEY_BYTES)
            if (desktopKey[0] != 0x04.toByte()) throw ChannelException("Not a pairing link")
            val relayUrl = bytes.copyOfRange(at, bytes.size).decodeToString()
            val secure = relayUrl.startsWith("wss://")
            if (!secure && !(allowInsecure && relayUrl.startsWith("ws://"))) {
                throw ChannelException("Unsupported relay")
            }
            if (relayUrl.any { it == '?' || it == '#' || it == '@' || it.isWhitespace() }) {
                throw ChannelException("Unsupported relay")
            }
            return PairingLink(relayUrl.trimEnd('/'), room, secret, desktopKey)
        }

        private const val LINK_VERSION: Byte = 1
        const val ROOM_BYTES = 16
        const val SECRET_BYTES = 32
        private const val FIXED = 1 + ROOM_BYTES + SECRET_BYTES + PUBLIC_KEY_BYTES
    }
}

const val PUBLIC_KEY_BYTES = 65

class ChannelException(message: String) : Exception(message)
