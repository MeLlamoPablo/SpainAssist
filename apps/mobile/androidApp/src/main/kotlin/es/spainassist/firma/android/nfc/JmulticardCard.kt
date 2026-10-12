package es.spainassist.firma.android.nfc

import android.nfc.Tag
import android.nfc.tech.IsoDep
import es.gob.jmulticard.callback.CustomTextInputCallback
import es.gob.jmulticard.card.AuthenticationModeLockedException
import es.gob.jmulticard.card.BadPinException
import es.gob.jmulticard.card.InvalidCardException
import es.gob.jmulticard.card.PinException
import es.gob.jmulticard.card.dnie.BurnedDnieCardException
import es.gob.jmulticard.card.dnie.DnieFactory
import es.gob.jmulticard.card.dnie.DnieNfc
import es.gob.jmulticard.card.dnie.InvalidAccessCodeException
import es.gob.jmulticard.card.icao.InvalidCanOrMrzException
import es.spainassist.firma.android.firmaLog
import es.spainassist.firma.app.LogArea
import es.spainassist.firma.card.Card
import es.spainassist.firma.card.CardException
import es.spainassist.firma.card.DnieSession
import es.spainassist.firma.protocol.Algorithm
import java.security.cert.CertificateExpiredException
import java.security.cert.CertificateNotYetValidException
import javax.security.auth.callback.Callback
import javax.security.auth.callback.CallbackHandler
import javax.security.auth.callback.PasswordCallback
import javax.security.auth.callback.UnsupportedCallbackException

/**
 * A DNIe 3.0/4.0 over NFC, through jmulticard (the library Autofirma uses): PACE with the CAN,
 * the CWA-14890 secure channel, and PSO signatures with AUTENTICACIÓN for login or FIRMA for documents. jmulticard asks the CAN
 * and the PIN through callbacks; we answer from what the user typed. It opens a new PACE
 * channel (and checks the PIN) for every signature, as the card requires.
 */
class JmulticardCard(tag: Tag) : Card {
    private val isoDep: IsoDep = IsoDep.get(tag) ?: throw CardException.Unsupported("Not an ISO-DEP card")
    private val connection = try {
        IsoDepConnection(isoDep)
    } catch (e: Exception) {
        log("connect failed: ${e::class.simpleName} ${e.message}")
        throw CardException.Lost()
    }

    override fun open(can: String, purpose: es.spainassist.firma.protocol.Purpose, pin: () -> String): DnieSession {
        val handler = CallbackHandler { callbacks ->
            for (callback in callbacks) answer(callback, can, pin)
        }
        val crypto = LoginCryptoHelper()
        log("PACE with the CAN (purpose=${purpose.name})")
        val dnie: DnieNfc = guard { DnieFactory.getDnieNfc(connection, crypto, handler) }
        log("PACE done: reading the certificate")
        val alias = guard { certificateAlias(dnie, purpose == es.spainassist.firma.protocol.Purpose.Login) }
            ?: throw CardException.NoCertificate().also { log("no certificate for ${purpose.name}") }
        val certificate = dnie.getCertificate(alias)
            ?: throw CardException.NoCertificate().also { log("no certificate under the alias") }
        try {
            certificate.checkValidity()
        } catch (e: CertificateExpiredException) {
            log("certificate expired")
            throw CardException.CertificateExpired()
        } catch (e: CertificateNotYetValidException) {
            log("certificate not yet valid")
            throw CardException.CertificateExpired()
        }
        val key = dnie.getPrivateKey(alias) ?: throw CardException.NoCertificate().also { log("no private key under the alias") }
        return object : DnieSession {
            override val certificates = listOf(certificate.encoded)

            override fun sign(data: ByteArray, algorithm: Algorithm, prehashed: Boolean): ByteArray =
                guard {
                    log("signing ${algorithm.name} prehashed=$prehashed (PIN check)")
                    crypto.setPrehashed(if (prehashed) data else null)
                    try { dnie.sign(data, algorithm.jcaName, key) }
                    finally { crypto.setPrehashed(null) }
                }.also { log("card signed") }
        }
    }

    override fun close() = connection.close()

    /** Select the purpose-specific alias, with digitalSignature/nonRepudiation as fallback. */
    private fun certificateAlias(dnie: DnieNfc, login: Boolean): String? {
        val aliases = dnie.aliases.orEmpty().toList()
        return aliases.firstOrNull { it.contains(if (login) "autentic" else "firma", ignoreCase = true) }
            ?: aliases.firstOrNull { dnie.getCertificate(it)?.keyUsage?.getOrNull(if (login) 0 else 1) == true }?.takeIf { !login || dnie.getCertificate(it)?.keyUsage?.getOrNull(1) != true }
    }

    private fun answer(callback: Callback, can: String, pin: () -> String) {
        when {
            callback is CustomTextInputCallback -> callback.text = can
            callback is PasswordCallback -> callback.password = pin().toCharArray()
            // Some Android versions have javax's TextInputCallback, which jmulticard tries first.
            callback.javaClass.name == "javax.security.auth.callback.TextInputCallback" ->
                callback.javaClass.getMethod("setText", String::class.java).invoke(callback, can)
            else -> throw UnsupportedCallbackException(callback)
        }
    }

    private fun log(message: String) = firmaLog(LogArea.Nfc, message)

    /** Runs a jmulticard call, turning its exceptions into [CardException]s. */
    private fun <T> guard(block: () -> T): T {
        try {
            return block()
        } catch (e: CardException) {
            throw e
        } catch (e: Exception) {
            throw classify(e)
        }
    }

    private fun classify(e: Throwable): CardException {
        val chain = generateSequence(e) { it.cause }.take(12).toList()
        // Class names only: jmulticard's messages may quote card data.
        log("jmulticard error: ${chain.joinToString(" <- ") { it.javaClass.simpleName }} lost=${connection.lost}")
        if (connection.lost) return CardException.Lost()
        chain.firstNotNullOfOrNull { it as? CardException }?.let { return it }
        for (cause in chain) {
            when (cause) {
                is AuthenticationModeLockedException -> return CardException.PinBlocked()
                is BadPinException ->
                    return if (cause.remainingRetries <= 0) CardException.PinBlocked() else CardException.WrongPin(cause.remainingRetries)
                is InvalidAccessCodeException, is InvalidCanOrMrzException -> return CardException.WrongCan()
                is BurnedDnieCardException -> return CardException.Unsupported("burnt DNIe")
                is InvalidCardException -> return CardException.Unsupported("not a DNIe")
                is PinException -> return CardException.Failed("PIN: ${cause.message}")
            }
        }
        return CardException.Failed(e.message ?: e.javaClass.simpleName)
    }
}
