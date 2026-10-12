package es.spainassist.firma.app

import es.spainassist.firma.card.NfcAvailability
import es.spainassist.firma.channel.PairingLink
import es.spainassist.firma.protocol.ErrorCode
import es.spainassist.firma.protocol.Need
import es.spainassist.firma.protocol.Purpose
import es.spainassist.firma.relay.LinkStatus

/** What the app shows. One at a time; [FirmaController] decides. */
sealed interface Screen {
    val nfc: NfcAvailability

    /** No pairing: explain, and scan the desktop's QR code. */
    data class Start(override val nfc: NfcAvailability, val notice: StartNotice? = null) : Screen

    /** A link was scanned or opened: pair only if the user is looking at their computer. */
    data class ConfirmPairing(
        override val nfc: NfcAvailability,
        val link: PairingLink,
        val replacing: Boolean,
    ) : Screen

    /** Paired, nothing to sign. */
    data class Home(
        override val nfc: NfcAvailability,
        val link: LinkStatus,
    ) : Screen

    /** A sign request from the desktop. */
    data class Signing(
        override val nfc: NfcAvailability,
        val request: Review,
        val step: Step,
        val connected: Boolean,
    ) : Screen
}

enum class StartNotice { BadLink, PairingEnded, PairingExpired, Replaced, DesktopUnpaired }

/** What the user can do on the screens ([FirmaController]; a no-op in the debug screen preview). */
interface FirmaActions {
    /** A link from a QR code or an App Link / `sa-firma://` intent. */
    fun onLink(text: String)

    fun confirmPairing()

    fun cancelPairing()

    fun unpair()

    fun openNfcSettings()

    fun approve()

    fun decline()

    /** Stops a request half-way (after approving). */
    fun cancel()

    /** Leaves a finished request's result. */
    fun dismissResult()
}

/** A request as the user reviews it. */
data class Review(
    val requestId: String,
    val purpose: Purpose,
    val host: String,
    val description: String,
    val format: String,
    val documents: List<ReviewDocument>,
    /** The phone checks every signature against the documents. */
    val verifiable: Boolean,
    val signatures: Int?,
)

data class ReviewDocument(
    val name: String?,
    val mimeType: String,
    val size: Long,
    val sha256: String,
    /** Null when the desktop didn't send it (too large). */
    val data: ByteArray?,
) {
    override fun equals(other: Any?): Boolean = other is ReviewDocument && other.sha256 == sha256 && other.name == name

    override fun hashCode(): Int = sha256.hashCode()
}

sealed interface Step {
    data object Review : Step

    /**
     * The user types the CAN or the PIN on the computer (`sign.need`). [refused]: the card refused
     * the one it had; [triesLeft]: PIN tries left after a wrong PIN.
     */
    data class WaitForComputer(val what: Need, val refused: Boolean, val triesLeft: Int?) : Step

    /** Waiting for the card; [moved]: it was there and left the field. */
    data class HoldCard(val moved: Boolean) : Step

    data class Working(val reading: Boolean, val signed: Int) : Step

    data class Result(val outcome: Outcome) : Step
}

sealed interface Outcome {
    data object Signed : Outcome

    data object CertificateShared : Outcome

    data object Declined : Outcome

    data object Cancelled : Outcome

    data object CancelledByDesktop : Outcome

    data object Expired : Outcome

    data class Failed(val code: ErrorCode) : Outcome
}
