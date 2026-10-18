package es.spainassist.firma.ui

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.key
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.produceState
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalUriHandler
import androidx.compose.ui.platform.UriHandler
import androidx.compose.ui.semantics.heading
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import es.spainassist.firma.app.LicenseGroup
import es.spainassist.firma.app.LicenseText
import es.spainassist.firma.app.Licenses
import es.spainassist.firma.app.Platform
import es.spainassist.firma.app.ProprietaryComponent
import es.spainassist.firma.resources.Res
import es.spainassist.firma.resources.*
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import org.jetbrains.compose.resources.stringResource

/** Our licence, the licence of the app as a whole, and every third-party notice (apps/mobile/NOTICE). */
@Composable
internal fun LicensesScreen(platform: Platform, onBack: () -> Unit) {
    val licenses = platform.licenses
    val uri = LocalUriHandler.current
    platform.BackHandler(onBack)
    val title = stringResource(Res.string.licenses_title)
    Page(title) {
        Title(title)
        Body(stringResource(if (licenses.eupl) Res.string.licenses_lead_eupl else Res.string.licenses_lead))
        Column {
            TextButton(onClick = { uri.openUri(Licenses.SOURCE_URL) }) { Text(stringResource(Res.string.licenses_source)) }
            if (licenses.eupl) {
                TextButton(onClick = { uri.openUri(Licenses.JMULTICARD_SOURCE_URL) }) {
                    Text(stringResource(Res.string.licenses_jmulticard_source))
                }
            }
        }
        licenses.groups.forEach { group -> key(group.license) { LicenseSection(group, uri) } }
        if (licenses.proprietary.isNotEmpty()) ProprietarySection(licenses.proprietary, platform, uri)
        Secondary(stringResource(Res.string.licenses_back), onBack)
    }
}

@Composable
private fun Subtitle(text: String) {
    Text(text, Modifier.semantics { heading() }, fontSize = 18.sp, fontWeight = FontWeight.SemiBold, color = colors.fg, lineHeight = 24.sp)
}

@Composable
private fun LicenseSection(group: LicenseGroup, uri: UriHandler) {
    var open by rememberSaveable { mutableStateOf(false) }
    Column(verticalArrangement = Arrangement.spacedBy(4.dp)) {
        Subtitle(group.license.title)
        group.components.forEach { component ->
            Text(component.name, color = colors.fg, fontSize = 15.sp, fontWeight = FontWeight.Medium)
            component.notice?.let { Text(it, color = colors.fgMuted, fontSize = 13.sp, lineHeight = 18.sp) }
        }
        TextButton(onClick = { open = !open }) {
            Text(stringResource(if (open) Res.string.licenses_hide_text else Res.string.licenses_show_text))
        }
        if (open) LicenseFile(group.license.path)
        if (group.license == LicenseText.Eupl12) {
            TextButton(onClick = { uri.openUri(Licenses.EUPL_URL) }) { Text(stringResource(Res.string.licenses_eupl_languages)) }
        }
    }
}

@Composable
private fun ProprietarySection(items: List<ProprietaryComponent>, platform: Platform, uri: UriHandler) {
    var open by rememberSaveable { mutableStateOf(false) }
    Column(verticalArrangement = Arrangement.spacedBy(4.dp)) {
        Subtitle(stringResource(Res.string.licenses_google_title))
        Body(stringResource(Res.string.licenses_google_body))
        items.forEach { item -> TextButton(onClick = { uri.openUri(item.termsUrl) }) { Text(item.name) } }
        TextButton(onClick = { open = !open }) {
            Text(stringResource(if (open) Res.string.licenses_google_hide else Res.string.licenses_google_notices))
        }
        if (open) BundledNotices(platform)
    }
}

@Composable
private fun BundledNotices(platform: Platform) {
    val notices by produceState<List<Pair<String, String>>?>(null) {
        value = withContext(Dispatchers.Default) { platform.bundledNotices() }
    }
    var shown by rememberSaveable { mutableStateOf<String?>(null) }
    notices?.forEach { (name, text) ->
        TextButton(onClick = { shown = name.takeIf { it != shown } }) { Text(name) }
        if (shown == name) LicenseBody(text)
    }
}

@Composable
private fun LicenseFile(path: String) {
    val text by produceState<String?>(null, path) { value = Res.readBytes(path).decodeToString() }
    text?.let { LicenseBody(it) }
}

@Composable
private fun LicenseBody(text: String) {
    Text(reflow(text), color = colors.fg, fontSize = 13.sp, lineHeight = 18.sp)
}

private val LIST_ITEM = Regex("""^(?:[-*•]|\(?[0-9a-z]{1,3}[.)])\s""")

/** Joins a licence's hard-wrapped lines into paragraphs that fit the screen, keeping list items. */
internal fun reflow(text: String): String =
    text.trim().replace("\r\n", "\n").split(Regex("""\n\s*\n""")).joinToString("\n\n") { paragraph ->
        paragraph.lines().map { it.trim() }.filter { it.isNotEmpty() }.reduceOrNull { joined, line ->
            joined + (if (LIST_ITEM.containsMatchIn(line)) "\n" else " ") + line
        }.orEmpty()
    }
