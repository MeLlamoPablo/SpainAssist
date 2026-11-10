package es.spainassist.firma.ui

import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertTrue

class SourcesTest {
    /** Users can check each source on an official domain, over HTTPS (docs/research/play-policy.md). */
    @Test
    fun everySourceIsAnOfficialSite() {
        for (source in OFFICIAL_SOURCES) {
            val host = source.host
            assertTrue(source.url.startsWith("https://") && '/' !in host, source.url)
            assertTrue(host.endsWith(".gob.es") || host == "www.dnielectronico.es", source.url)
        }
        assertEquals(OFFICIAL_SOURCES.size, OFFICIAL_SOURCES.map { it.name.key }.toSet().size, "a source is listed twice")
    }
}
