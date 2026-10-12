package es.spainassist.firma.card

import es.spainassist.firma.protocol.Algorithm
import kotlinx.coroutines.flow.StateFlow

enum class NfcAvailability { Ready, Disabled, Missing }

/**
 * The phone's NFC reader. Platform code (Android: reader mode + jmulticard) implements it; the
 * reader is only active while a request waits for or uses the card.
 */
interface CardReader {
    val nfc: StateFlow<NfcAvailability>

    /** Suspends until a card is held to the phone. Cancel to stop reading. */
    suspend fun awaitCard(): Card
}

/** A card in the NFC field. Blocking calls: run them off the main thread. */
interface Card {
    /**
     * Opens the DNIe: PACE with the [can], then reads AUTENTICACIÓN for login or FIRMA otherwise. [pin] is
     * asked whenever the card needs it (each signature).
     * Throws [CardException].
     */
    fun open(can: String, purpose: es.spainassist.firma.protocol.Purpose, pin: () -> String): DnieSession

    fun close()
}

interface DnieSession {
    /** DER, leaf first; chosen for the requested purpose. */
    val certificates: List<ByteArray>

    /** PKCS#1 v1.5 over data, or a validated pre-hashed digest for login. Throws [CardException]. */
    fun sign(data: ByteArray, algorithm: Algorithm, prehashed: Boolean = false): ByteArray
}

sealed class CardException(message: String) : Exception(message) {
    /** The card left the field (moved, or the phone was lifted). Hold it again. */
    class Lost : CardException("card lost")

    /** PACE failed: the CAN doesn't match this card. */
    class WrongCan : CardException("wrong CAN")

    class WrongPin(val retriesLeft: Int) : CardException("wrong PIN")

    class PinBlocked : CardException("PIN blocked")

    /** Not a DNIe 3.0/4.0, or a damaged ("burnt") one. */
    class Unsupported(message: String) : CardException(message)

    /** The card has no certificate for the requested purpose. */
    class NoCertificate : CardException("no requested certificate")

    class CertificateExpired : CardException("certificate expired")

    class Failed(message: String) : CardException(message)
}
