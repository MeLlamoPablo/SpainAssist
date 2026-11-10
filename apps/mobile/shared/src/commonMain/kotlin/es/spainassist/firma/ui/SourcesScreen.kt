package es.spainassist.firma.ui

import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.Icon
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.platform.LocalUriHandler
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import es.spainassist.firma.app.Platform
import es.spainassist.firma.resources.Res
import es.spainassist.firma.resources.*
import org.jetbrains.compose.resources.StringResource
import org.jetbrains.compose.resources.stringResource

/** A government site the information in the app comes from. */
internal data class OfficialSource(val name: StringResource, val url: String) {
    val host get() = url.removePrefix("https://")
}

/** The same sources, in the same order, as the store description (docs/play-listing.md). */
internal val OFFICIAL_SOURCES = listOf(
    OfficialSource(Res.string.source_dnie, "https://www.dnielectronico.es"),
    OfficialSource(Res.string.source_signature, "https://firmaelectronica.gob.es"),
    OfficialSource(Res.string.source_sedes, "https://administracion.gob.es"),
    OfficialSource(Res.string.source_clave, "https://clave.gob.es"),
    OfficialSource(Res.string.source_tax_agency, "https://sede.agenciatributaria.gob.es"),
)

/**
 * That the app doesn't represent the government, and where the government information it shows
 * comes from: Google Play asks apps that touch government services for both
 * (docs/research/play-policy.md). From the start screen and the "⋯" menu.
 */
@Composable
internal fun SourcesScreen(platform: Platform, onBack: () -> Unit) {
    platform.BackHandler(onBack)
    val title = stringResource(Res.string.sources_title)
    Page(title) {
        Title(title)
        Banner(stringResource(Res.string.start_disclaimer), Tone.Info, live = false)
        Body(stringResource(Res.string.sources_lead))
        SourceList()
        Secondary(stringResource(Res.string.back), onBack)
    }
}

/**
 * Each source opens in the browser. TalkBack reads a row as one item, with the host rather than
 * the whole URL: "Cl@ve, clave.gob.es, opens in the browser".
 */
@Composable
private fun SourceList() {
    val uri = LocalUriHandler.current
    val opens = stringResource(Res.string.a11y_opens_browser)
    val shape = RoundedCornerShape(12.dp)
    Column(Modifier.fillMaxWidth().clip(shape).border(1.dp, colors.lineStrong, shape)) {
        OFFICIAL_SOURCES.forEachIndexed { i, source ->
            if (i > 0) HorizontalDivider(color = colors.line)
            Row(
                Modifier.fillMaxWidth().clickable(role = Role.Button) { uri.openUri(source.url) }
                    .padding(start = 16.dp, end = 16.dp, top = 12.dp, bottom = 12.dp),
                horizontalArrangement = Arrangement.spacedBy(12.dp),
                verticalAlignment = Alignment.CenterVertically,
            ) {
                Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(2.dp)) {
                    Text(stringResource(source.name), fontSize = 16.sp, fontWeight = FontWeight.Medium, color = colors.fg, lineHeight = 22.sp)
                    Text(
                        source.url, Modifier.semantics { contentDescription = source.host },
                        fontSize = 14.sp, color = colors.fgSubtle, lineHeight = 20.sp,
                    )
                }
                Icon(LineIcons.OpenOutside, opens, Modifier.size(16.dp), tint = colors.fgSubtle)
            }
        }
    }
}
