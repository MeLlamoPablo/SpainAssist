package es.spainassist.firma.channel

import dev.whyoleg.cryptography.CryptographyProvider
import dev.whyoleg.cryptography.DelicateCryptographyApi
import dev.whyoleg.cryptography.algorithms.AES
import dev.whyoleg.cryptography.algorithms.EC
import dev.whyoleg.cryptography.algorithms.ECDH
import dev.whyoleg.cryptography.algorithms.HMAC
import dev.whyoleg.cryptography.algorithms.SHA1
import dev.whyoleg.cryptography.algorithms.SHA256
import dev.whyoleg.cryptography.algorithms.SHA384
import dev.whyoleg.cryptography.algorithms.SHA512
import dev.whyoleg.cryptography.random.CryptographyRandom
import kotlin.io.encoding.Base64

/** The few primitives the channel needs, on the platform's own crypto (JCA, CryptoKit). */
internal object Crypto {
    private val provider get() = CryptographyProvider.Default

    fun randomBytes(size: Int): ByteArray = CryptographyRandom.nextBytes(size)

    fun hmacSha256(key: ByteArray, data: ByteArray): ByteArray =
        provider.get(HMAC).keyDecoder(SHA256)
            .decodeFromByteArrayBlocking(HMAC.Key.Format.RAW, key)
            .signatureGenerator()
            .generateSignatureBlocking(data)

    /** RFC 5869 with HMAC-SHA256 (built from HMAC, like the desktop). */
    fun hkdfSha256(ikm: ByteArray, salt: ByteArray, info: ByteArray, length: Int): ByteArray {
        val prk = hmacSha256(salt, ikm)
        val out = ArrayList<Byte>(length)
        var previous = ByteArray(0)
        var counter = 1
        while (out.size < length) {
            previous = hmacSha256(prk, previous + info + byteArrayOf(counter.toByte()))
            out.addAll(previous.toList())
            counter++
        }
        return out.take(length).toByteArray()
    }

    /** SHA-1 too: some sites still ask for SHA1withRSA signatures. */
    @OptIn(DelicateCryptographyApi::class)
    fun digest(name: String, data: ByteArray): ByteArray {
        val id = when (name) {
            "SHA-1" -> SHA1
            "SHA-256" -> SHA256
            "SHA-384" -> SHA384
            "SHA-512" -> SHA512
            else -> throw IllegalArgumentException("Unsupported digest $name")
        }
        return provider.get(id).hasher().hashBlocking(data)
    }

    class EcdhKeyPair internal constructor(
        internal val privateKey: ECDH.PrivateKey,
        /** Uncompressed P-256 point (65 bytes). */
        val publicKey: ByteArray,
    )

    fun generateKeyPair(): EcdhKeyPair {
        val pair = provider.get(ECDH).keyPairGenerator(EC.Curve.P256).generateKeyBlocking()
        return EcdhKeyPair(pair.privateKey, pair.publicKey.encodeToByteArrayBlocking(EC.PublicKey.Format.RAW))
    }

    /** Test vectors: a fixed key. */
    fun keyPairFrom(privateKey: ByteArray, publicKey: ByteArray): EcdhKeyPair =
        EcdhKeyPair(
            provider.get(ECDH).privateKeyDecoder(EC.Curve.P256)
                .decodeFromByteArrayBlocking(EC.PrivateKey.Format.RAW, privateKey),
            publicKey,
        )

    fun ecdh(mine: EcdhKeyPair, peerPublicKey: ByteArray): ByteArray {
        if (peerPublicKey.size != PUBLIC_KEY_BYTES || peerPublicKey[0] != 0x04.toByte()) {
            throw ChannelException("Bad public key")
        }
        val peer = try {
            provider.get(ECDH).publicKeyDecoder(EC.Curve.P256)
                .decodeFromByteArrayBlocking(EC.PublicKey.Format.RAW, peerPublicKey)
        } catch (e: Exception) {
            throw ChannelException("Bad public key")
        }
        return mine.privateKey.sharedSecretGenerator().generateSharedSecretToByteArrayBlocking(peer)
    }

    @OptIn(DelicateCryptographyApi::class)
    fun aesGcmSeal(key: ByteArray, iv: ByteArray, plaintext: ByteArray, aad: ByteArray): ByteArray =
        provider.get(AES.GCM).keyDecoder().decodeFromByteArrayBlocking(AES.Key.Format.RAW, key)
            .cipher()
            .encryptWithIvBlocking(iv, plaintext, aad)

    @OptIn(DelicateCryptographyApi::class)
    fun aesGcmOpen(key: ByteArray, iv: ByteArray, ciphertext: ByteArray, aad: ByteArray): ByteArray =
        try {
            provider.get(AES.GCM).keyDecoder().decodeFromByteArrayBlocking(AES.Key.Format.RAW, key)
                .cipher()
                .decryptWithIvBlocking(iv, ciphertext, aad)
        } catch (e: Exception) {
            throw ChannelException("Bad frame")
        }
}

internal fun ByteArray.toHex(): String = joinToString("") { (it.toInt() and 0xff).toString(16).padStart(2, '0') }

internal fun String.hexToBytes(): ByteArray {
    require(length % 2 == 0) { "Odd hex" }
    return ByteArray(length / 2) { substring(it * 2, it * 2 + 2).toInt(16).toByte() }
}

internal val Base64Std = Base64.Default
internal val Base64Url = Base64.UrlSafe.withPadding(Base64.PaddingOption.ABSENT_OPTIONAL)
