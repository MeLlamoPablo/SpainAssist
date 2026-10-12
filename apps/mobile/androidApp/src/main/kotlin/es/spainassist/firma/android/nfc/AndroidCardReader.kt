package es.spainassist.firma.android.nfc

import android.app.Activity
import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.content.IntentFilter
import android.nfc.NfcAdapter
import android.nfc.Tag
import android.os.Bundle
import androidx.core.content.ContextCompat
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

    init {
        ContextCompat.registerReceiver(
            context,
            object : BroadcastReceiver() {
                override fun onReceive(context: Context, intent: Intent) {
                    _nfc.value = availability()
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
    fun refresh() {
        _nfc.value = availability()
    }

    override suspend fun awaitCard(): Card {
        // A tag from before we started waiting is stale.
        tags.tryReceive()
        while (true) {
            val tag = tags.receive()
            try {
                return JmulticardCard(tag)
            } catch (e: CardException.Lost) {
                // Gone before we could connect: wait for the next one.
            }
        }
    }

    /** Reader mode on (the activity is resumed and the app waits for or uses a card). */
    fun attach(activity: Activity) {
        val nfc = adapter ?: return
        val extras = Bundle().apply {
            // Check less often that the card is still there: slow card operations must not be
            // mistaken for a card that left (Autofirma's AA300103).
            putInt(NfcAdapter.EXTRA_READER_PRESENCE_CHECK_DELAY, PRESENCE_CHECK_MS)
        }
        nfc.enableReaderMode(
            activity,
            { tag -> tags.trySend(tag) },
            NfcAdapter.FLAG_READER_NFC_A or NfcAdapter.FLAG_READER_NFC_B or
                NfcAdapter.FLAG_READER_SKIP_NDEF_CHECK or NfcAdapter.FLAG_READER_NO_PLATFORM_SOUNDS,
            extras,
        )
    }

    fun detach(activity: Activity) {
        adapter?.disableReaderMode(activity)
    }

    companion object {
        private const val PRESENCE_CHECK_MS = 2_000
    }
}
