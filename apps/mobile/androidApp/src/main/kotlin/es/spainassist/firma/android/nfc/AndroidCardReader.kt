package es.spainassist.firma.android.nfc

import android.app.Activity
import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.content.IntentFilter
import android.nfc.NfcAdapter
import android.nfc.Tag
import android.nfc.tech.IsoDep
import android.os.Bundle
import androidx.core.content.ContextCompat
import es.spainassist.firma.android.firmaLog
import es.spainassist.firma.app.LogArea
import es.spainassist.firma.card.Card
import es.spainassist.firma.card.CardException
import es.spainassist.firma.card.CardReader
import es.spainassist.firma.card.NfcAvailability
import kotlinx.coroutines.channels.Channel
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow

/**
 * NFC through reader mode: [MainActivity] turns it on while the app waits for or uses a card and
 * is in the foreground ([attach]/[detach]); discovered tags go to whoever is in [awaitCard].
 * Turning it off drops the tag, so it stays on while the card is in use.
 */
class AndroidCardReader(context: Context) : CardReader {
    private val adapter: NfcAdapter? = NfcAdapter.getDefaultAdapter(context)
    private val _nfc = MutableStateFlow(availability())
    override val nfc: StateFlow<NfcAvailability> = _nfc.asStateFlow()
    private val tags = Channel<Tag>(Channel.CONFLATED)

    /** Reader mode is on (set on the main thread). */
    private var reading = false

    /** Someone is in [awaitCard] (read on the NFC thread). */
    @Volatile
    private var waiting = false

    init {
        ContextCompat.registerReceiver(
            context,
            object : BroadcastReceiver() {
                override fun onReceive(context: Context, intent: Intent) {
                    setAvailability("adapter state changed")
                }
            },
            IntentFilter(NfcAdapter.ACTION_ADAPTER_STATE_CHANGED),
            ContextCompat.RECEIVER_NOT_EXPORTED,
        )
    }

    private fun availability(): NfcAvailability = when {
        adapter == null -> NfcAvailability.Missing
        adapter.isEnabled -> NfcAvailability.Ready
        else -> NfcAvailability.Disabled
    }

    /** The user came back from the NFC settings, maybe. */
    fun refresh() = setAvailability("refresh")

    private fun setAvailability(why: String) {
        val next = availability()
        if (_nfc.value != next) log("NFC ${_nfc.value} -> $next ($why)")
        _nfc.value = next
    }

    override suspend fun awaitCard(): Card {
        // A tag from before we started waiting is stale.
        if (tags.tryReceive().isSuccess) log("stale tag dropped")
        waiting = true
        try {
            while (true) {
                val tag = tags.receive()
                try {
                    return JmulticardCard(tag)
                } catch (e: CardException.Lost) {
                    // Gone before we could connect: wait for the next one.
                    log("tag gone before connecting: waiting for the next one")
                } catch (e: CardException) {
                    log("tag rejected: ${e::class.simpleName} ${e.message}")
                    throw e
                }
            }
        } finally {
            waiting = false
        }
    }

    private fun onTag(tag: Tag) {
        val techs = tag.techList.joinToString(",") { it.substringAfterLast('.') }
        val isoDep = IsoDep::class.java.name in tag.techList
        log("tag discovered: techs=$techs isoDep=$isoDep" + if (waiting) "" else " (nothing waiting: kept until dropped as stale)")
        tags.trySend(tag)
    }

    /**
     * Reader mode on (the activity is resumed and the app waits for or uses a card). [why] is for
     * the log.
     */
    fun attach(activity: Activity, why: String) {
        val nfc = adapter ?: return log("reader mode not turned on: no NFC adapter ($why)")
        if (!nfc.isEnabled) log("turning reader mode on with NFC off ($why)")
        val extras = Bundle().apply {
            // Check less often that the card is still there: slow card operations must not be
            // mistaken for a card that left (Autofirma's AA300103).
            putInt(NfcAdapter.EXTRA_READER_PRESENCE_CHECK_DELAY, PRESENCE_CHECK_MS)
        }
        nfc.enableReaderMode(
            activity,
            ::onTag,
            NfcAdapter.FLAG_READER_NFC_A or NfcAdapter.FLAG_READER_NFC_B or
                NfcAdapter.FLAG_READER_SKIP_NDEF_CHECK or NfcAdapter.FLAG_READER_NO_PLATFORM_SOUNDS,
            extras,
        )
        if (!reading) log("reader mode on ($why)")
        reading = true
    }

    fun detach(activity: Activity, why: String) {
        adapter?.disableReaderMode(activity)
        if (reading) log("reader mode off ($why)")
        reading = false
    }

    private fun log(message: String) = firmaLog(LogArea.Nfc, message)

    companion object {
        private const val PRESENCE_CHECK_MS = 2_000
    }
}
