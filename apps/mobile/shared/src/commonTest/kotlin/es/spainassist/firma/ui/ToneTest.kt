package es.spainassist.firma.ui

import kotlin.test.Test
import kotlin.test.assertEquals

class ToneTest {
    /** TalkBack tells the tones apart by name, not only by colour. */
    @Test
    fun everyToneHasItsOwnSpokenName() {
        val labels = Tone.entries.map { toneLabel(it).key }
        assertEquals(Tone.entries.size, labels.toSet().size, "labels: $labels")
    }
}
