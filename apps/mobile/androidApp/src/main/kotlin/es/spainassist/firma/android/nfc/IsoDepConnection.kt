package es.spainassist.firma.android.nfc

import android.nfc.TagLostException
import android.nfc.tech.IsoDep
import es.gob.jmulticard.apdu.ResponseApdu
import es.gob.jmulticard.connection.AbstractApduConnectionIso7816
import es.gob.jmulticard.connection.ApduConnection
import es.gob.jmulticard.connection.ApduConnectionException
import es.gob.jmulticard.connection.ApduConnectionProtocol
import java.io.IOException

/**
 * jmulticard's APDU connection over Android's IsoDep (like its AndroidNfcConnection), with a
 * longer timeout for slow card operations and a [lost] flag: once the card leaves the field,
 * every error is reported as "the card moved", whatever jmulticard wraps it in.
 */
class IsoDepConnection(private val isoDep: IsoDep) : AbstractApduConnectionIso7816() {
    @Volatile
    var lost = false
        private set

    init {
        if (!isoDep.isConnected) isoDep.connect()
        isoDep.timeout = TIMEOUT_MS
    }

    override fun internalTransmit(apdu: ByteArray): ResponseApdu {
        if (lost) throw ApduConnectionException("The card left the field")
        val response = try {
            isoDep.transceive(apdu)
        } catch (e: TagLostException) {
            lost = true
            throw ApduConnectionException("The card left the field", e)
        } catch (e: IOException) {
            if (!isoDep.isConnected) lost = true
            throw ApduConnectionException("NFC transmission failed", e)
        } catch (e: SecurityException) {
            // Android throws this for a tag that is out of date (it left the field).
            lost = true
            throw ApduConnectionException("The card left the field", e)
        }
        return ResponseApdu(response)
    }

    override fun open() {
        try {
            if (!isoDep.isConnected) isoDep.connect()
        } catch (e: IOException) {
            lost = true
            throw ApduConnectionException("Can't connect to the card", e)
        }
    }

    override fun close() {
        try {
            isoDep.close()
        } catch (e: IOException) {
            // already gone
        }
    }

    override fun reset(): ByteArray =
        isoDep.historicalBytes ?: isoDep.hiLayerResponse ?: throw ApduConnectionException("No ATR")

    override fun getTerminals(onlyWithCardPresent: Boolean): LongArray = longArrayOf(0)

    override fun getTerminalInfo(terminal: Int): String = "Android IsoDep"

    override fun setTerminal(t: Int) = Unit

    override fun isOpen(): Boolean = isoDep.isConnected

    override fun setProtocol(p: ApduConnectionProtocol) = Unit

    override fun getSubConnection(): ApduConnection? = null

    override fun getMaxApduSize(): Int = 0xff

    companion object {
        private const val TIMEOUT_MS = 5_000
    }
}
