package es.spainassist.firma.ui

import java.io.File
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertTrue

/** The Spanish and English strings, including the ones only TalkBack reads, match key for key. */
class StringsTest {
    private val resources = File("src/commonMain/composeResources")

    private fun keys(dir: String): Set<String> =
        Regex("""<string name="([^"]+)"""").findAll(File(resources, "$dir/strings.xml").readText()).map { it.groupValues[1] }.toSet()

    @Test
    fun everyStringIsInBothLanguages() {
        val es = keys("values")
        val en = keys("values-en")
        assertEquals(emptySet(), es - en, "missing in English")
        assertEquals(emptySet(), en - es, "missing in Spanish")
    }

    @Test
    fun theScreenReaderLabelsExist() {
        val es = keys("values")
        for (key in listOf("a11y_status_info", "a11y_status_done", "a11y_status_attention", "a11y_status_blocked", "a11y_site_official", "a11y_site_unknown", "a11y_scan_camera", "menu_more", "review_open_pdf")) {
            assertTrue(key in es, key)
        }
    }
}
