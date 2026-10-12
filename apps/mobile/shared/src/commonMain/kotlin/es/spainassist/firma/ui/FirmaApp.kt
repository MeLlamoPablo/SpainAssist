package es.spainassist.firma.ui

import androidx.compose.foundation.Canvas
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.BoxWithConstraints
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.ColumnScope
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.safeDrawingPadding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.CheckCircle
import androidx.compose.material.icons.filled.Info
import androidx.compose.material.icons.filled.Warning
import androidx.compose.material.icons.outlined.Info
import androidx.compose.material.icons.outlined.Warning
import androidx.compose.material.icons.rounded.Check
import androidx.compose.material3.Button
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.DropdownMenu
import androidx.compose.material3.DropdownMenuItem
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontStyle
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import es.spainassist.firma.app.FirmaActions
import es.spainassist.firma.app.FirmaController
import es.spainassist.firma.app.Outcome
import es.spainassist.firma.app.Platform
import es.spainassist.firma.app.Review
import es.spainassist.firma.app.ReviewDocument
import es.spainassist.firma.app.Screen
import es.spainassist.firma.app.StartNotice
import es.spainassist.firma.app.Step
import es.spainassist.firma.card.NfcAvailability
import es.spainassist.firma.protocol.ErrorCode
import es.spainassist.firma.protocol.Need
import es.spainassist.firma.protocol.Purpose
import es.spainassist.firma.relay.LinkStatus
import es.spainassist.firma.resources.Res
import es.spainassist.firma.resources.*
import org.jetbrains.compose.resources.StringResource
import org.jetbrains.compose.resources.stringResource

@Composable
fun FirmaApp(controller: FirmaController, platform: Platform) {
    val screen by controller.screen.collectAsStateWithLifecycle()
    FirmaScreens(screen, controller, platform)
}

/** What the app shows on top of the controller's [Screen] while the user has nothing to approve. */
enum class Overlay { Scanner, Licenses }

/** The app for a given [screen]; the debug build's screen preview renders it with mock screens. */
@Composable
fun FirmaScreens(screen: Screen, actions: FirmaActions, platform: Platform, initialOverlay: Overlay? = null) {
    var overlay by rememberSaveable { mutableStateOf(initialOverlay) }
    val idle = screen is Screen.Start || screen is Screen.ConfirmPairing || screen is Screen.Home
    val start = screen is Screen.Start
    // A pairing or a request takes over; afterwards the app is back on its own screen.
    LaunchedEffect(idle, start) {
        if (!idle || (!start && overlay == Overlay.Scanner)) overlay = null
    }
    FirmaTheme {
        Surface(modifier = Modifier.fillMaxSize(), color = MaterialTheme.colorScheme.background) {
            Box(Modifier.safeDrawingPadding()) {
                val openLicenses = { overlay = Overlay.Licenses }
                when {
                    overlay == Overlay.Licenses && idle -> LicensesScreen(platform) { overlay = null }
                    overlay == Overlay.Scanner && screen is Screen.Start -> ScanScreen(platform, actions) { overlay = null }
                    else -> when (screen) {
                        is Screen.Start -> StartScreen(screen, actions, openLicenses) { overlay = Overlay.Scanner }
                        is Screen.ConfirmPairing -> ConfirmPairingScreen(screen, actions, openLicenses)
                        is Screen.Home -> HomeScreen(screen, actions, openLicenses)
                        is Screen.Signing -> SigningScreen(screen, actions, platform)
                    }
                }
            }
        }
    }
}

// ---------------------------------------------------------------------------------------------
// Building blocks
// ---------------------------------------------------------------------------------------------

internal val colors @Composable get() = LocalFirmaColors.current

/**
 * Every screen but the licences: a picture up top ([hero]: the wordmark, the card, the result)
 * and the words and buttons at the bottom, within reach of the thumb. It scrolls when they don't
 * fit. [menu] adds the "⋯" menu in the corner.
 */
@Composable
private fun Layout(
    hero: @Composable () -> Unit,
    top: Dp = 128.dp,
    menu: (() -> Unit)? = null,
    bottom: @Composable ColumnScope.() -> Unit,
) {
    BoxWithConstraints(Modifier.fillMaxSize()) {
        val height = maxHeight
        Column(Modifier.fillMaxSize().verticalScroll(rememberScrollState())) {
            Column(
                Modifier.fillMaxWidth().heightIn(min = height).padding(start = 24.dp, end = 24.dp, top = top, bottom = 64.dp),
                verticalArrangement = Arrangement.SpaceBetween,
            ) {
                Box(Modifier.fillMaxWidth(), contentAlignment = Alignment.TopCenter) { hero() }
                Spacer(Modifier.height(64.dp))
                Column(Modifier.fillMaxWidth(), verticalArrangement = Arrangement.spacedBy(64.dp), content = bottom)
            }
        }
        if (menu != null) MoreMenu(menu, Modifier.align(Alignment.TopEnd).padding(top = 14.dp, end = 14.dp))
    }
}

/** A title and what it means, 10 dp apart. */
@Composable
private fun Words(content: @Composable ColumnScope.() -> Unit) {
    Column(Modifier.fillMaxWidth(), verticalArrangement = Arrangement.spacedBy(10.dp), content = content)
}

/** Notices and buttons, 24 dp apart. */
@Composable
private fun Actions(content: @Composable ColumnScope.() -> Unit) {
    Column(Modifier.fillMaxWidth(), verticalArrangement = Arrangement.spacedBy(24.dp), content = content)
}

/** Top-aligned and scrolling: the licences. */
@Composable
internal fun Page(content: @Composable () -> Unit) {
    Column(
        modifier = Modifier.fillMaxSize().verticalScroll(rememberScrollState()).padding(start = 24.dp, end = 24.dp, top = 32.dp, bottom = 64.dp),
        verticalArrangement = Arrangement.spacedBy(16.dp),
    ) { content() }
}

@Composable
internal fun Title(text: String) {
    Text(text, fontSize = 24.sp, fontWeight = FontWeight.SemiBold, color = colors.fg, lineHeight = 30.sp)
}

@Composable
internal fun Body(text: String, color: Color = colors.fgSubtle) {
    Text(text, fontSize = 16.sp, color = color, lineHeight = 22.sp)
}

/** "Spain Assist" with the flag, as on the desktop (Framer's App/Brand/Wordmark, Large). */
@Composable
internal fun Wordmark() {
    val brand = brandFamily()
    Row(
        Modifier.semantics(mergeDescendants = true) {},
        horizontalArrangement = Arrangement.spacedBy(11.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        val shape = RoundedCornerShape(5.dp)
        Column(Modifier.size(width = 39.dp, height = 26.dp).clip(shape).border(1.3.dp, colors.flagOutline, shape)) {
            Box(Modifier.fillMaxWidth().weight(1f).background(colors.flagRed))
            Box(Modifier.fillMaxWidth().weight(2f).background(colors.flagYellow))
            Box(Modifier.fillMaxWidth().weight(1f).background(colors.flagRed))
        }
        for ((word, style) in listOf("Spain" to FontStyle.Normal, "Assist" to FontStyle.Italic)) {
            Text(word, fontFamily = brand, fontStyle = style, fontSize = 44.sp, lineHeight = 44.sp, letterSpacing = (-0.88).sp, color = colors.fg)
        }
    }
}

/** The "⋯" button and its menu: the licences. */
@Composable
private fun MoreMenu(openLicenses: () -> Unit, modifier: Modifier) {
    var open by remember { mutableStateOf(false) }
    val label = stringResource(Res.string.menu_more)
    Box(modifier) {
        IconButton(onClick = { open = true }, modifier = Modifier.semantics { contentDescription = label }) {
            val fg = colors.fg
            Canvas(Modifier.size(24.dp)) {
                val r = 2.dp.toPx()
                for (x in listOf(5, 12, 19)) drawCircle(fg, r, Offset(x.dp.toPx(), 12.dp.toPx()))
            }
        }
        DropdownMenu(expanded = open, onDismissRequest = { open = false }) {
            DropdownMenuItem(
                text = { Text(stringResource(Res.string.licenses_open), fontSize = 16.sp, color = colors.fg) },
                onClick = {
                    open = false
                    openLicenses()
                },
            )
        }
    }
}

private enum class Tone { Info, Done, Attention, Blocked }

@Composable
private fun Banner(text: String, tone: Tone, action: (@Composable () -> Unit)? = null) {
    val (bg, fg, icon) = when (tone) {
        Tone.Info -> Triple(colors.surface3, colors.fgMuted, Icons.Filled.Info)
        Tone.Done -> Triple(colors.doneBg, colors.doneFg, Icons.Filled.CheckCircle)
        Tone.Attention -> Triple(colors.attentionBg, colors.attentionFg, Icons.Filled.Warning)
        Tone.Blocked -> Triple(colors.blockedBg, colors.blockedFg, Icons.Filled.Warning)
    }
    Column(
        Modifier.fillMaxWidth().background(bg, RoundedCornerShape(12.dp)).padding(14.dp),
        verticalArrangement = Arrangement.spacedBy(10.dp),
    ) {
        Row(horizontalArrangement = Arrangement.spacedBy(10.dp)) {
            Icon(icon, contentDescription = null, tint = fg, modifier = Modifier.size(20.dp))
            Text(text, color = fg, fontSize = 15.sp, lineHeight = 21.sp)
        }
        action?.invoke()
    }
}

@Composable
private fun Primary(text: String, onClick: () -> Unit, enabled: Boolean = true) {
    Button(onClick = onClick, enabled = enabled, modifier = Modifier.fillMaxWidth().height(52.dp), shape = RoundedCornerShape(12.dp)) {
        Text(text, fontSize = 16.sp, fontWeight = FontWeight.SemiBold)
    }
}

@Composable
internal fun Secondary(text: String, onClick: () -> Unit) {
    OutlinedButton(onClick = onClick, modifier = Modifier.fillMaxWidth().height(52.dp), shape = RoundedCornerShape(12.dp)) {
        Text(text, fontSize = 16.sp, fontWeight = FontWeight.Medium, color = colors.fg)
    }
}

@Composable
private fun NfcBanner(nfc: NfcAvailability, actions: FirmaActions) {
    when (nfc) {
        NfcAvailability.Missing -> Banner(stringResource(Res.string.nfc_missing), Tone.Blocked)
        NfcAvailability.Disabled -> Banner(stringResource(Res.string.nfc_disabled), Tone.Attention) {
            TextButton(onClick = actions::openNfcSettings) {
                Text(stringResource(Res.string.nfc_open_settings), color = colors.attentionFg, fontWeight = FontWeight.SemiBold)
            }
        }
        NfcAvailability.Ready -> Unit
    }
}

/** A card resting on a phone: the gesture the user must make. */
@Composable
private fun CardIllustration(active: Boolean) {
    Box(Modifier.fillMaxWidth().height(170.dp), contentAlignment = Alignment.Center) {
        Box(
            Modifier.size(width = 190.dp, height = 120.dp)
                .background(colors.accentSoft, RoundedCornerShape(12.dp))
                .border(2.dp, colors.accent, RoundedCornerShape(12.dp)),
        ) {
            Text("DNIe", modifier = Modifier.padding(12.dp), color = colors.accentText, fontWeight = FontWeight.SemiBold)
        }
        Box(
            Modifier.padding(start = 70.dp, top = 30.dp).size(width = 86.dp, height = 150.dp)
                .background(colors.surface, RoundedCornerShape(16.dp))
                .border(2.dp, colors.fg, RoundedCornerShape(16.dp)),
            contentAlignment = Alignment.Center,
        ) {
            if (active) CircularProgressIndicator(Modifier.size(28.dp), strokeWidth = 3.dp)
        }
    }
}

/** A computer with a PIN being typed: the user answers on the computer. */
@Composable
private fun ComputerIllustration() {
    Column(Modifier.height(170.dp), verticalArrangement = Arrangement.Center, horizontalAlignment = Alignment.CenterHorizontally) {
        Box(
            Modifier.size(width = 180.dp, height = 116.dp)
                .background(colors.surface, RoundedCornerShape(topStart = 12.dp, topEnd = 12.dp))
                .border(2.dp, colors.fg, RoundedCornerShape(topStart = 12.dp, topEnd = 12.dp)),
            contentAlignment = Alignment.Center,
        ) {
            Row(
                Modifier.background(colors.accentSoft, RoundedCornerShape(8.dp)).padding(horizontal = 14.dp, vertical = 12.dp),
                horizontalArrangement = Arrangement.spacedBy(8.dp),
            ) {
                repeat(4) { Box(Modifier.size(10.dp).background(colors.fg, CircleShape)) }
            }
        }
        Box(
            Modifier.size(width = 220.dp, height = 14.dp)
                .background(colors.accentSoft, RoundedCornerShape(bottomStart = 8.dp, bottomEnd = 8.dp))
                .border(2.dp, colors.fg, RoundedCornerShape(bottomStart = 8.dp, bottomEnd = 8.dp)),
        )
    }
}

/** A result: a round badge in the result's colours. */
@Composable
private fun ResultIcon(tone: Tone) {
    val (bg, fg, icon) = when (tone) {
        Tone.Done -> Triple(colors.doneBg, colors.doneFg, Icons.Rounded.Check)
        Tone.Blocked -> Triple(colors.blockedBg, colors.blockedFg, Icons.Outlined.Warning)
        Tone.Attention -> Triple(colors.attentionBg, colors.attentionFg, Icons.Outlined.Info)
        Tone.Info -> Triple(colors.surface3, colors.fgSubtle, Icons.Outlined.Info)
    }
    Box(Modifier.size(88.dp).background(bg, CircleShape), contentAlignment = Alignment.Center) {
        Icon(icon, contentDescription = null, tint = fg, modifier = Modifier.size(44.dp))
    }
}

// ---------------------------------------------------------------------------------------------
// Start, pairing, home
// ---------------------------------------------------------------------------------------------

@Composable
private fun StartScreen(s: Screen.Start, actions: FirmaActions, openLicenses: () -> Unit, scan: () -> Unit) {
    Layout(hero = { Wordmark() }, menu = openLicenses) {
        Actions {
            when (s.notice) {
                StartNotice.BadLink -> Banner(stringResource(Res.string.notice_bad_link), Tone.Attention)
                StartNotice.PairingEnded -> Banner(stringResource(Res.string.notice_ended), Tone.Info)
                StartNotice.PairingExpired -> Banner(stringResource(Res.string.notice_expired), Tone.Info)
                StartNotice.Replaced -> Banner(stringResource(Res.string.notice_replaced), Tone.Attention)
                StartNotice.DesktopUnpaired -> Banner(stringResource(Res.string.notice_desktop_unpaired), Tone.Info)
                null -> Unit
            }
            NfcBanner(s.nfc, actions)
            Primary(stringResource(Res.string.start_scan), onClick = scan, enabled = s.nfc != NfcAvailability.Missing)
        }
    }
}

@Composable
private fun ScanScreen(platform: Platform, actions: FirmaActions, close: () -> Unit) {
    platform.BackHandler(close)
    Column(Modifier.fillMaxSize().padding(start = 24.dp, end = 24.dp, top = 24.dp, bottom = 64.dp)) {
        Box(Modifier.fillMaxWidth().weight(1f).clip(RoundedCornerShape(16.dp)).background(Color.Black)) {
            platform.QrScanner { code ->
                close()
                actions.onLink(code)
            }
        }
        Spacer(Modifier.height(24.dp))
        Title(stringResource(Res.string.scan_title))
        Spacer(Modifier.height(64.dp))
        Secondary(stringResource(Res.string.scan_cancel), close)
    }
}

@Composable
private fun ConfirmPairingScreen(s: Screen.ConfirmPairing, actions: FirmaActions, openLicenses: () -> Unit) {
    Layout(hero = { Wordmark() }, menu = openLicenses) {
        Words {
            Title(stringResource(Res.string.pair_title))
            Body(stringResource(Res.string.pair_body))
        }
        Actions {
            if (s.replacing) Banner(stringResource(Res.string.pair_replacing), Tone.Attention)
            Primary(stringResource(Res.string.pair_confirm), onClick = actions::confirmPairing)
            Secondary(stringResource(Res.string.pair_cancel), actions::cancelPairing)
        }
    }
}

@Composable
private fun HomeScreen(s: Screen.Home, actions: FirmaActions, openLicenses: () -> Unit) {
    Layout(hero = { Wordmark() }, menu = openLicenses) {
        Actions {
            NfcBanner(s.nfc, actions)
            when (s.link) {
                is LinkStatus.Connected -> Banner(stringResource(Res.string.home_connected), Tone.Done)
                LinkStatus.DesktopAway -> Banner(stringResource(Res.string.home_away), Tone.Attention)
                is LinkStatus.Outdated -> Banner(stringResource(Res.string.home_outdated), Tone.Blocked)
                else -> Banner(stringResource(Res.string.home_connecting), Tone.Info)
            }
            Secondary(stringResource(Res.string.home_unpair), actions::unpair)
        }
    }
}

// ---------------------------------------------------------------------------------------------
// Signing
// ---------------------------------------------------------------------------------------------

@Composable
private fun SigningScreen(s: Screen.Signing, actions: FirmaActions, platform: Platform) {
    val login = s.request.purpose == Purpose.Login
    // Shown above the buttons while the computer is away (the request goes on when it's back).
    val away: @Composable () -> Unit = { if (!s.connected) Banner(stringResource(Res.string.review_disconnected), Tone.Info) }
    when (val step = s.step) {
        Step.Review -> ReviewStep(s.request, s.nfc, actions, platform, away)
        is Step.WaitForComputer -> WaitStep(step, actions, !login, away)
        is Step.HoldCard -> Layout(hero = { CardIllustration(active = false) }) {
            Words {
                Title(stringResource(Res.string.card_title))
                Body(stringResource(Res.string.card_body))
            }
            // An empty group would still take its 64 dp gap (a login can't be cancelled here).
            if (!login || !s.connected || step.moved || s.nfc != NfcAvailability.Ready) {
                Actions {
                    away()
                    NfcBanner(s.nfc, actions)
                    if (step.moved) Banner(stringResource(Res.string.card_moved), Tone.Attention)
                    if (!login) Secondary(stringResource(Res.string.cancel_label), actions::cancel)
                }
            }
        }
        is Step.Working -> Layout(hero = { CardIllustration(active = true) }) {
            Words {
                Title(stringResource(if (login) Res.string.working_login else if (step.reading) Res.string.working_reading else Res.string.working_signing))
                Body(stringResource(Res.string.working_hint))
                if (login) Body(stringResource(Res.string.login_cancel_desktop))
                else if (step.signed > 0) Body(stringResource(Res.string.working_signed, step.signed))
            }
            if (!s.connected) Actions { away() }
        }
        is Step.Result -> ResultStep(step.outcome, actions, login)
    }
}

@Composable
private fun ReviewStep(r: Review, nfc: NfcAvailability, actions: FirmaActions, platform: Platform, away: @Composable () -> Unit) {
    val certificateOnly = r.purpose == Purpose.Certificate
    val login = r.purpose == Purpose.Login
    val title = stringResource(if (login) Res.string.review_title_login else if (certificateOnly) Res.string.review_title_certificate else Res.string.review_title, r.host)
    val buttons: @Composable ColumnScope.() -> Unit = {
        Actions {
            away()
            NfcBanner(nfc, actions)
            if (!login && !certificateOnly) {
                if (r.verifiable) Banner(stringResource(Res.string.review_checked), Tone.Done)
                else Banner(stringResource(Res.string.review_unchecked), Tone.Info)
            }
            Primary(
                stringResource(if (login) Res.string.review_login else if (certificateOnly) Res.string.review_share else Res.string.review_sign),
                onClick = actions::approve,
            )
            Secondary(stringResource(Res.string.review_decline), actions::decline)
        }
    }
    if (login || certificateOnly) {
        // Nothing to read: it looks like the pairing question.
        Layout(hero = { Wordmark() }) {
            Words {
                Title(title)
                Body(stringResource(if (login) Res.string.review_login_body else Res.string.review_certificate_body))
            }
            buttons()
        }
        return
    }
    // The documents take the place of the picture.
    Layout(
        top = 32.dp,
        hero = {
            Column(Modifier.fillMaxWidth(), verticalArrangement = Arrangement.spacedBy(16.dp)) {
                Words {
                    Title(title)
                    Body(r.description)
                    r.signatures?.takeIf { it > 1 }?.let { Body(stringResource(Res.string.review_signatures, it)) }
                }
                r.documents.forEach { DocumentPreview(it, platform) }
            }
        },
        bottom = buttons,
    )
}

@Composable
private fun DocumentPreview(d: ReviewDocument, platform: Platform) {
    Column(
        Modifier.fillMaxWidth().border(1.dp, colors.line, RoundedCornerShape(12.dp)).background(colors.surface2, RoundedCornerShape(12.dp)).padding(12.dp),
        verticalArrangement = Arrangement.spacedBy(8.dp),
    ) {
        val kind = when {
            d.mimeType == "application/pdf" -> Res.string.doc_pdf
            d.mimeType.endsWith("xml") -> Res.string.doc_xml
            d.mimeType.startsWith("text/") -> Res.string.doc_text
            else -> Res.string.doc_other
        }
        Text(d.name ?: stringResource(kind), fontWeight = FontWeight.SemiBold, color = colors.fg)
        Text(formatSize(d.size), color = colors.fgSubtle, fontSize = 13.sp)
        val data = d.data
        when {
            data == null -> {
                Body(stringResource(Res.string.review_no_data))
                Text("SHA-256 ${d.sha256}", fontFamily = FontFamily.Monospace, fontSize = 11.sp, color = colors.fgSubtle)
            }
            d.mimeType == "application/pdf" -> Box(Modifier.fillMaxWidth().heightIn(max = 420.dp)) { platform.PdfPreview(data) }
            d.mimeType.startsWith("text/") || d.mimeType.endsWith("xml") -> {
                val text = remember(d.sha256) { data.decodeToString().take(6000) }
                Box(Modifier.fillMaxWidth().heightIn(max = 320.dp).verticalScroll(rememberScrollState())) {
                    Text(text, fontFamily = FontFamily.Monospace, fontSize = 12.sp, color = colors.fg)
                }
            }
            else -> Text("SHA-256 ${d.sha256}", fontFamily = FontFamily.Monospace, fontSize = 11.sp, color = colors.fgSubtle)
        }
    }
}

/** The card refused the CAN or the PIN (or none came): the user types it on the computer. */
@Composable
private fun WaitStep(step: Step.WaitForComputer, actions: FirmaActions, canCancel: Boolean, away: @Composable () -> Unit) {
    val pin = step.what == Need.Pin
    val left = step.triesLeft
    Layout(hero = { ComputerIllustration() }) {
        Words {
            Title(stringResource(if (pin) Res.string.wait_pin_title else Res.string.wait_can_title))
            if (pin && !step.refused && left != 1) Body(stringResource(Res.string.wait_pin_missing))
            Row(horizontalArrangement = Arrangement.spacedBy(10.dp), verticalAlignment = Alignment.CenterVertically) {
                CircularProgressIndicator(Modifier.size(16.dp), color = colors.fgSubtle, strokeWidth = 2.dp)
                Body(stringResource(Res.string.wait_body))
            }
        }
        Actions {
            away()
            when {
                !pin -> Banner(stringResource(Res.string.wait_can_wrong), Tone.Attention)
                left == 1 -> Banner(stringResource(Res.string.pin_last_try), Tone.Blocked)
                step.refused && left != null -> Banner(stringResource(Res.string.wait_pin_wrong, left), Tone.Attention)
            }
            if (canCancel) Secondary(stringResource(Res.string.cancel_label), actions::cancel)
        }
    }
}

@Composable
private fun ResultStep(outcome: Outcome, actions: FirmaActions, login: Boolean) {
    val (message, tone) = when (outcome) {
        Outcome.Signed -> (if (login) Res.string.result_login else Res.string.result_signed) to Tone.Done
        Outcome.CertificateShared -> Res.string.result_certificate to Tone.Done
        Outcome.Declined -> (if (login) Res.string.result_login_declined else Res.string.result_declined) to Tone.Info
        Outcome.Cancelled -> Res.string.result_cancelled to Tone.Info
        Outcome.CancelledByDesktop -> (if (login) Res.string.result_login_cancelled else Res.string.result_cancelled_desktop) to Tone.Info
        Outcome.Expired -> Res.string.result_expired to Tone.Attention
        is Outcome.Failed -> failure(outcome.code, login) to Tone.Blocked
    }
    Layout(hero = { ResultIcon(tone) }) {
        Words { Title(stringResource(message)) }
        Actions { Primary(stringResource(Res.string.result_ok), onClick = actions::dismissResult) }
    }
}

private fun failure(code: ErrorCode, login: Boolean): StringResource = when (code) {
    ErrorCode.PinBlocked -> Res.string.result_pin_blocked
    ErrorCode.CardUnsupported -> Res.string.result_unsupported
    ErrorCode.NoCertificate -> Res.string.result_no_certificate
    ErrorCode.CertificateExpired -> Res.string.result_certificate_expired
    ErrorCode.WrongCard -> Res.string.result_wrong_card
    ErrorCode.BindingMismatch -> Res.string.result_mismatch
    ErrorCode.Timeout -> Res.string.result_timeout
    ErrorCode.NfcUnavailable -> Res.string.nfc_missing
    else -> (if (login) Res.string.result_login_failed else Res.string.result_failed)
}

private fun formatSize(bytes: Long): String = when {
    bytes < 1024 -> "$bytes B"
    bytes < 1024 * 1024 -> "${(bytes * 10 / 1024) / 10.0} KB"
    else -> "${(bytes * 10 / (1024 * 1024)) / 10.0} MB"
}
