package es.spainassist.firma.protocol

import kotlinx.serialization.ExperimentalSerializationApi
import kotlinx.serialization.SerialName
import kotlinx.serialization.Serializable
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonClassDiscriminator

/**
 * The desktop ↔ phone messages: a mirror of `packages/shared/src/companion.ts` (the contract).
 * The desktop validates with strict schemas, so the phone never sends fields it doesn't know
 * and leaves out empty optional ones.
 */
const val COMPANION_PROTOCOL = 5

/** Largest decrypted message, after joining fragments (same as the desktop). */
const val MAX_MESSAGE_BYTES = 24 * 1024 * 1024

val CompanionJson = Json {
    classDiscriminator = "type"
    explicitNulls = false
    encodeDefaults = true
    ignoreUnknownKeys = false
}

@Serializable
data class Hello(
    val type: String = "hello",
    val protocol: Int = COMPANION_PROTOCOL,
    val app: String,
    val platform: String,
    val device: String,
)

@Serializable
data class Welcome(
    val type: String,
    val protocol: Int,
    val app: String,
    val expiresAt: String,
)

@Serializable
enum class Purpose {
    @SerialName("document") Document,
    @SerialName("certificate") Certificate,
    @SerialName("login") Login,
}

@Serializable
enum class Algorithm(val digest: String) {
    @SerialName("SHA1withRSA") Sha1("SHA-1"),
    @SerialName("SHA256withRSA") Sha256("SHA-256"),
    @SerialName("SHA384withRSA") Sha384("SHA-384"),
    @SerialName("SHA512withRSA") Sha512("SHA-512"),
    ;

    /** The JCA name jmulticard expects. */
    val jcaName: String get() = name.uppercase() + "withRSA"
}

@Serializable
data class CompanionDocument(
    val name: String? = null,
    val mimeType: String,
    val size: Long,
    val sha256: String,
    /** Base64, when the desktop sent the document itself. */
    val data: String? = null,
)

@OptIn(ExperimentalSerializationApi::class)
@Serializable
@JsonClassDiscriminator("kind")
sealed interface Check {
    val document: Int

    @Serializable
    @SerialName("cms")
    data class Cms(override val document: Int) : Check

    @Serializable
    @SerialName("pades")
    data class Pades(
        override val document: Int,
        /** Base64 of the incremental update appended to the document. */
        val update: String,
        val byteRange: List<Long>,
    ) : Check
}

@Serializable
enum class CancelReason {
    @SerialName("cancelled") Cancelled,
    @SerialName("timeout") Timeout,
    @SerialName("failed") Failed,
}

@Serializable
sealed interface DesktopToPhone

@Serializable
@SerialName("sign.request")
data class SignRequest(
    val requestId: String,
    val purpose: Purpose,
    val origin: String,
    val description: String,
    val format: String,
    val documents: List<CompanionDocument>,
    val verifiable: Boolean,
    val signatures: Int? = null,
    val expiresAt: String,
    /** The DNI's CAN (6 digits), typed on the desktop. The phone never stores it. */
    val can: String,
    /**
     * The DNIe PIN typed on the desktop (8 to 16 characters); absent for certificate reads and in
     * a request sent again after a reconnect. Used for this request only, never stored, and never
     * tried again once the card refuses it ([SignNeed]).
     */
    val pin: String? = null,
) : DesktopToPhone

/** The CAN or PIN the phone asked for with [SignNeed], typed on the desktop. */
@Serializable
@SerialName("sign.unlock")
data class SignUnlock(
    val requestId: String,
    val can: String? = null,
    val pin: String? = null,
    /** The request's new deadline (ISO 8601). */
    val expiresAt: String,
) : DesktopToPhone

@Serializable
@SerialName("sign.toBeSigned")
data class ToBeSigned(
    val requestId: String,
    val seq: Int,
    val algorithm: Algorithm,
    /** Base64. */
    val data: String,
    val check: Check? = null,
    val prehashed: Boolean? = null,
) : DesktopToPhone

@Serializable
@SerialName("sign.done")
data class SignDone(val requestId: String) : DesktopToPhone

@Serializable
@SerialName("sign.cancel")
data class SignCancel(val requestId: String, val reason: CancelReason) : DesktopToPhone

@Serializable
@SerialName("bye")
data object DesktopBye : DesktopToPhone

@Serializable
enum class Stage {
    @SerialName("reviewing") Reviewing,
    @SerialName("card") Card,
    @SerialName("reading") Reading,
    @SerialName("signing") Signing,
}

@Serializable
enum class ErrorCode {
    @SerialName("rejected") Rejected,
    @SerialName("cancelled") Cancelled,
    @SerialName("busy") Busy,
    @SerialName("pin_blocked") PinBlocked,
    @SerialName("card_unsupported") CardUnsupported,
    @SerialName("no_certificate") NoCertificate,
    @SerialName("certificate_expired") CertificateExpired,
    @SerialName("wrong_card") WrongCard,
    @SerialName("binding_mismatch") BindingMismatch,
    @SerialName("nfc_unavailable") NfcUnavailable,
    @SerialName("timeout") Timeout,
    @SerialName("protocol") Protocol,
    @SerialName("internal") Internal,
}

@Serializable
sealed interface PhoneToDesktop

@Serializable
@SerialName("sign.progress")
data class SignProgress(val requestId: String, val stage: Stage) : PhoneToDesktop

@Serializable
@SerialName("sign.certificate")
data class SignCertificate(
    val requestId: String,
    /** Base64 DER, leaf first. */
    val certificates: List<String>,
) : PhoneToDesktop

@Serializable
@SerialName("sign.signature")
data class SignSignature(val requestId: String, val seq: Int, val signature: String) : PhoneToDesktop

@Serializable
@SerialName("sign.error")
data class SignError(
    val requestId: String,
    val code: ErrorCode,
    val message: String? = null,
) : PhoneToDesktop

@Serializable
enum class Need {
    @SerialName("can") Can,
    @SerialName("pin") Pin,
}

/**
 * The phone needs a new CAN or PIN and waits for [SignUnlock]: the card refused the one it had
 * ([refused]; [triesLeft] after a wrong PIN), or the request came without it. Never carries a CAN
 * or a PIN.
 */
@Serializable
@SerialName("sign.need")
data class SignNeed(
    val requestId: String,
    val what: Need,
    val refused: Boolean,
    val triesLeft: Int? = null,
) : PhoneToDesktop

@Serializable
@SerialName("bye")
data object PhoneBye : PhoneToDesktop
