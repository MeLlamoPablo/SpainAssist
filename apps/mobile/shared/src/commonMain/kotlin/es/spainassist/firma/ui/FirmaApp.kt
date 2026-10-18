package es.spainassist.firma.ui

import androidx.compose.foundation.Canvas
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
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
import androidx.compose.ui.draw.drawBehind
import androidx.compose.ui.geometry.CornerRadius
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.geometry.Size
import androidx.compose.ui.graphics.Brush
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.PathEffect
import androidx.compose.ui.graphics.drawscope.Stroke
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.semantics.LiveRegionMode
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.clearAndSetSemantics
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.heading
import androidx.compose.ui.semantics.liveRegion
import androidx.compose.ui.semantics.paneTitle
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontStyle
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
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
 *
 * [pane] names the screen for TalkBack, which reads it out when the screen appears or the name
 * changes (a new step of the signature, its result): the screen reader follows the steps without
 * the user having to explore the screen.
 */
@Composable
private fun Layout(
    hero: @Composable () -> Unit,
    pane: String,
    top: Dp = 128.dp,
    menu: (() -> Unit)? = null,
    bottom: @Composable ColumnScope.() -> Unit,
) {
    BoxWithConstraints(Modifier.fillMaxSize().semantics { paneTitle = pane }) {
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

/** Top-aligned and scrolling: the licences. [pane] as in [Layout]. */
@Composable
internal fun Page(pane: String, content: @Composable () -> Unit) {
    Column(
        modifier = Modifier.fillMaxSize().semantics { paneTitle = pane }.verticalScroll(rememberScrollState()).padding(start = 24.dp, end = 24.dp, top = 32.dp, bottom = 64.dp),
        verticalArrangement = Arrangement.spacedBy(16.dp),
    ) { content() }
}

/** A screen's title: a heading, so TalkBack can jump to it. */
@Composable
internal fun Title(text: String) {
    Text(
        text, Modifier.semantics { heading() },
        fontSize = 24.sp, fontWeight = FontWeight.SemiBold, color = colors.fg, lineHeight = 30.sp,
    )
}

@Composable
internal fun Body(text: String, modifier: Modifier = Modifier, color: Color = colors.fgSubtle) {
    Text(text, modifier, fontSize = 16.sp, color = color, lineHeight = 22.sp)
}

/**
 * "Spain Assist" with the flag, as on the desktop (Framer's App/Brand/Wordmark, Large). A logo: its
 * size ignores the font scale, or at 200 % "Assist" would break across lines. [heading] when it is
 * the screen's only title.
 */
@Composable
internal fun Wordmark(heading: Boolean = false) {
    val brand = brandFamily()
    val size = with(LocalDensity.current) { 44.dp.toSp() }
    Row(
        Modifier.semantics(mergeDescendants = true) { if (heading) heading() },
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
            Text(word, fontFamily = brand, fontStyle = style, fontSize = size, lineHeight = size, letterSpacing = (-0.88).sp, color = colors.fg)
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

/**
 * How a notice or a result went. Each has its own icon as well as its colour, and its own name for
 * TalkBack ([toneLabel]), so the colour never carries the meaning alone.
 */
internal enum class Tone { Info, Done, Attention, Blocked }

internal fun toneLabel(tone: Tone): StringResource = when (tone) {
    Tone.Info -> Res.string.a11y_status_info
    Tone.Done -> Res.string.a11y_status_done
    Tone.Attention -> Res.string.a11y_status_attention
    Tone.Blocked -> Res.string.a11y_status_blocked
}

/**
 * A notice. TalkBack reads its icon and text as one item ("Warning, NFC is off…"), and announces it
 * when it appears or its text changes ([live]): the computer leaving, the card moving, a wrong PIN.
 */
@Composable
private fun Banner(text: String, tone: Tone, live: Boolean = true, action: (@Composable () -> Unit)? = null) {
    val (bg, fg, icon) = when (tone) {
        Tone.Info -> Triple(colors.surface3, colors.fgMuted, Icons.Filled.Info)
        Tone.Done -> Triple(colors.doneBg, colors.doneFg, Icons.Filled.CheckCircle)
        Tone.Attention -> Triple(colors.attentionBg, colors.attentionFg, Icons.Filled.Warning)
        Tone.Blocked -> Triple(colors.blockedBg, colors.blockedFg, LineIcons.Blocked)
    }
    Column(
        Modifier.fillMaxWidth().background(bg, RoundedCornerShape(12.dp)).padding(14.dp),
        verticalArrangement = Arrangement.spacedBy(10.dp),
    ) {
        Row(
            Modifier.semantics(mergeDescendants = true) { if (live) liveRegion = LiveRegionMode.Polite },
            horizontalArrangement = Arrangement.spacedBy(10.dp),
        ) {
            Icon(icon, contentDescription = stringResource(toneLabel(tone)), tint = fg, modifier = Modifier.size(20.dp))
            Text(text, color = fg, fontSize = 15.sp, lineHeight = 21.sp)
        }
        action?.invoke()
    }
}

// Buttons grow with the font scale: a minimum height, never a fixed one.
@Composable
private fun Primary(text: String, onClick: () -> Unit, enabled: Boolean = true) {
    Button(onClick = onClick, enabled = enabled, modifier = Modifier.fillMaxWidth().heightIn(min = 52.dp), shape = RoundedCornerShape(12.dp)) {
        Text(text, fontSize = 16.sp, fontWeight = FontWeight.SemiBold)
    }
}

@Composable
internal fun Secondary(text: String, onClick: () -> Unit) {
    OutlinedButton(onClick = onClick, modifier = Modifier.fillMaxWidth().heightIn(min = 52.dp), shape = RoundedCornerShape(12.dp)) {
        Text(text, fontSize = 16.sp, fontWeight = FontWeight.Medium, color = colors.fg)
    }
}

@Composable
private fun NfcBanner(nfc: NfcAvailability, actions: FirmaActions) {
    when (nfc) {
        NfcAvailability.Missing -> Banner(stringResource(Res.string.nfc_missing), Tone.Blocked)
        NfcAvailability.Disabled -> Banner(stringResource(Res.string.nfc_disabled), Tone.Attention, action = {
            TextButton(onClick = actions::openNfcSettings) {
                Text(stringResource(Res.string.nfc_open_settings), color = colors.attentionFg, fontWeight = FontWeight.SemiBold)
            }
        })
        NfcAvailability.Ready -> Unit
    }
}

/** A card resting on a phone: the gesture the user must make. Decorative: the title says it. */
@Composable
private fun CardIllustration(active: Boolean) {
    Box(Modifier.fillMaxWidth().height(170.dp).clearAndSetSemantics {}, contentAlignment = Alignment.Center) {
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

/** A computer with a PIN being typed: the user answers on the computer. Decorative. */
@Composable
private fun ComputerIllustration() {
    Column(Modifier.height(170.dp).clearAndSetSemantics {}, verticalArrangement = Arrangement.Center, horizontalAlignment = Alignment.CenterHorizontally) {
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

/** A result: a round badge in the result's colours, with an icon of its own for each tone. */
@Composable
private fun ResultIcon(tone: Tone) {
    val (bg, fg, icon) = when (tone) {
        Tone.Done -> Triple(colors.doneBg, colors.doneFg, Icons.Rounded.Check)
        Tone.Blocked -> Triple(colors.blockedBg, colors.blockedFg, LineIcons.Blocked)
        Tone.Attention -> Triple(colors.attentionBg, colors.attentionFg, Icons.Outlined.Warning)
        Tone.Info -> Triple(colors.surface3, colors.fgSubtle, Icons.Outlined.Info)
    }
    Box(Modifier.size(88.dp).background(bg, CircleShape), contentAlignment = Alignment.Center) {
        Icon(icon, contentDescription = stringResource(toneLabel(tone)), tint = fg, modifier = Modifier.size(44.dp))
    }
}

// ---------------------------------------------------------------------------------------------
// Start, pairing, home
// ---------------------------------------------------------------------------------------------

@Composable
private fun StartScreen(s: Screen.Start, actions: FirmaActions, openLicenses: () -> Unit, scan: () -> Unit) {
    Layout(hero = { Wordmark(heading = true) }, pane = stringResource(Res.string.app_name), menu = openLicenses) {
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
    val title = stringResource(Res.string.scan_title)
    val camera = stringResource(Res.string.a11y_scan_camera)
    Column(Modifier.fillMaxSize().semantics { paneTitle = title }.padding(start = 24.dp, end = 24.dp, top = 24.dp, bottom = 64.dp)) {
        Box(
            Modifier.fillMaxWidth().weight(1f).clip(RoundedCornerShape(16.dp)).background(Color.Black)
                .semantics { contentDescription = camera },
        ) {
            platform.QrScanner { code ->
                close()
                actions.onLink(code)
            }
        }
        Spacer(Modifier.height(24.dp))
        Title(title)
        Spacer(Modifier.height(64.dp))
        Secondary(stringResource(Res.string.scan_cancel), close)
    }
}

@Composable
private fun ConfirmPairingScreen(s: Screen.ConfirmPairing, actions: FirmaActions, openLicenses: () -> Unit) {
    val title = stringResource(Res.string.pair_title)
    Layout(hero = { Wordmark() }, pane = title, menu = openLicenses) {
        Words {
            Title(title)
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
    Layout(hero = { Wordmark(heading = true) }, pane = stringResource(Res.string.app_name), menu = openLicenses) {
        Actions {
            NfcBanner(s.nfc, actions)
            // One banner whose text changes, so TalkBack announces each change of the link.
            val (status, tone) = when (s.link) {
                is LinkStatus.Connected -> Res.string.home_connected to Tone.Done
                LinkStatus.DesktopAway, LinkStatus.RoomMissing -> Res.string.home_away to Tone.Attention
                is LinkStatus.Outdated -> Res.string.home_outdated to Tone.Blocked
                else -> Res.string.home_connecting to Tone.Info
            }
            Banner(stringResource(status), tone)
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
        is Step.HoldCard -> Layout(hero = { CardIllustration(active = false) }, pane = stringResource(Res.string.card_title)) {
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
        is Step.Working -> {
            val title = stringResource(if (login) Res.string.working_login else if (step.reading) Res.string.working_reading else Res.string.working_signing)
            // Reading, then signing: the same screen with a new name, which TalkBack announces.
            Layout(hero = { CardIllustration(active = true) }, pane = title) {
                Words {
                    Title(title)
                    Body(stringResource(Res.string.working_hint))
                    if (!login && step.signed > 0) {
                        Body(stringResource(Res.string.working_signed, step.signed), Modifier.semantics { liveRegion = LiveRegionMode.Polite })
                    }
                }
                if (!s.connected) Actions { away() }
            }
        }
        is Step.Result -> ResultStep(step.outcome, actions, login)
    }
}

@Composable
private fun ReviewStep(r: Review, nfc: NfcAvailability, actions: FirmaActions, platform: Platform, away: @Composable () -> Unit) {
    val certificateOnly = r.purpose == Purpose.Certificate
    val login = r.purpose == Purpose.Login
    val unknown = stringResource(if (login) Res.string.review_unknown_login else if (certificateOnly) Res.string.review_unknown_certificate else Res.string.review_unknown_sign)
    val buttons: @Composable ColumnScope.() -> Unit = {
        Actions {
            away()
            NfcBanner(nfc, actions)
            if (!login && !certificateOnly && !r.verifiable) Banner(stringResource(Res.string.review_unchecked), Tone.Info, live = false)
            Primary(
                stringResource(if (login) Res.string.review_login else if (certificateOnly) Res.string.review_share else Res.string.review_sign),
                onClick = actions::approve,
            )
            Secondary(stringResource(Res.string.review_decline), actions::decline)
        }
    }
    if (login || certificateOnly) {
        // Nothing to read: the wordmark, and the site at the bottom.
        val title = stringResource(if (login) Res.string.review_title_login else Res.string.review_title_certificate)
        Layout(hero = { Wordmark() }, pane = "$title ${r.host}") {
            Column(Modifier.fillMaxWidth(), verticalArrangement = Arrangement.spacedBy(24.dp)) {
                Column(verticalArrangement = Arrangement.spacedBy(12.dp)) {
                    // What and for whom, read as one heading: "Log in to, official site, sede…".
                    Column(
                        Modifier.semantics(mergeDescendants = true) { heading() },
                        verticalArrangement = Arrangement.spacedBy(24.dp),
                    ) {
                        Text(title, fontSize = 16.sp, fontWeight = FontWeight.Medium, color = colors.fgSubtle, lineHeight = 22.sp)
                        Site(r.host, r.official)
                    }
                    if (!r.official) UnknownSite(unknown)
                }
                if (certificateOnly) Body(stringResource(Res.string.review_certificate_body))
            }
            buttons()
        }
        return
    }
    // The documents take the place of the picture.
    val title = stringResource(if (r.documents.size > 1) Res.string.review_title_documents else Res.string.review_title)
    Layout(
        top = 32.dp,
        pane = title,
        hero = {
            Column(Modifier.fillMaxWidth(), verticalArrangement = Arrangement.spacedBy(16.dp)) {
                Column(Modifier.fillMaxWidth(), verticalArrangement = Arrangement.spacedBy(12.dp)) {
                    // What and for whom, read as one heading: "Sign document, official site, sede…, 3 signatures".
                    Column(
                        Modifier.fillMaxWidth().semantics(mergeDescendants = true) { heading() },
                        verticalArrangement = Arrangement.spacedBy(12.dp),
                    ) {
                        Title(title)
                        Site(r.host, r.official)
                        r.signatures?.takeIf { it > 1 }?.let { Body(stringResource(Res.string.review_signatures, it)) }
                    }
                    if (!r.official) UnknownSite(unknown)
                }
                r.documents.forEach { DocumentPreview(it, platform) }
            }
        },
        bottom = buttons,
    )
}

/**
 * The site that asks: its host with a lock when it's an official administration, else a question
 * mark, dashed, in the warning colour. TalkBack reads the icon's meaning before the host.
 */
@Composable
private fun Site(host: String, official: Boolean) {
    val shape = RoundedCornerShape(12.dp)
    val tone = if (official) colors.doneFg else colors.blockedFg
    val frame = if (official) {
        Modifier.background(colors.surface3, shape).border(1.dp, colors.lineStrong, shape)
    } else {
        Modifier.background(colors.blockedBg, shape).dashedBorder(colors.blockedLine, 12.dp)
    }
    Row(
        frame.padding(start = 12.dp, end = 14.dp, top = 10.dp, bottom = 10.dp),
        horizontalArrangement = Arrangement.spacedBy(8.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Icon(
            if (official) LineIcons.Lock else LineIcons.Question,
            contentDescription = stringResource(if (official) Res.string.a11y_site_official else Res.string.a11y_site_unknown),
            tint = tone,
            modifier = Modifier.size(18.dp),
        )
        Text(host, fontSize = 17.sp, fontWeight = FontWeight.SemiBold, color = colors.fg, lineHeight = 24.sp)
    }
}

/** Below a site the app doesn't recognise: sign only if you trust it. */
@Composable
private fun UnknownSite(text: String) {
    Text(text, fontSize = 14.sp, color = colors.blockedFg, lineHeight = 20.sp)
}

/** A 1 dp dashed outline with rounded corners. */
private fun Modifier.dashedBorder(color: Color, radius: Dp): Modifier = drawBehind {
    val width = 1.dp.toPx()
    val dash = 4.dp.toPx()
    drawRoundRect(
        color = color,
        topLeft = Offset(width / 2, width / 2),
        size = Size(size.width - width, size.height - width),
        cornerRadius = CornerRadius(radius.toPx() - width / 2),
        style = Stroke(width, pathEffect = PathEffect.dashPathEffect(floatArrayOf(dash, dash))),
    )
}

/**
 * The top of a document, fading into the page, with its name and size. A PDF opens in the
 * phone's PDF viewer when tapped. A document too big to show has no preview: its name follows the
 * notice instead of covering it, so nothing clips when the font is large.
 */
@Composable
private fun DocumentPreview(d: ReviewDocument, platform: Platform) {
    val kind = when {
        d.mimeType == "application/pdf" -> Res.string.doc_pdf
        d.mimeType.endsWith("xml") -> Res.string.doc_xml
        d.mimeType.startsWith("text/") -> Res.string.doc_text
        else -> Res.string.doc_other
    }
    val data = d.data
    val pdf = data?.takeIf { d.mimeType == "application/pdf" }
    val name = d.name ?: stringResource(kind)
    val openLabel = stringResource(Res.string.review_open_pdf)
    val shape = RoundedCornerShape(topStart = 16.dp, topEnd = 16.dp)
    if (data == null) {
        Column(
            Modifier.fillMaxWidth().clip(shape).background(colors.surface2).padding(16.dp),
            verticalArrangement = Arrangement.spacedBy(8.dp),
        ) {
            Body(stringResource(Res.string.review_no_data))
            Text("SHA-256 ${d.sha256}", fontFamily = FontFamily.Monospace, fontSize = 11.sp, color = colors.fgSubtle)
            DocumentName(name, d.size, Modifier.padding(top = 8.dp))
        }
        return
    }
    Box(Modifier.fillMaxWidth().height(200.dp).clip(shape)) {
        val page = Modifier.fillMaxSize().background(colors.surface2).padding(16.dp)
        when {
            pdf != null -> platform.PdfPreview(pdf)
            d.mimeType.startsWith("text/") || d.mimeType.endsWith("xml") -> {
                val text = remember(d.sha256) { data.decodeToString().take(2000) }
                Text(text, page, fontFamily = FontFamily.Monospace, fontSize = 12.sp, color = colors.fg)
            }
            else -> Text("SHA-256 ${d.sha256}", page, fontFamily = FontFamily.Monospace, fontSize = 11.sp, color = colors.fgSubtle)
        }
        Box(
            Modifier.align(Alignment.BottomCenter).fillMaxWidth().height(110.dp)
                .background(Brush.verticalGradient(listOf(colors.surface.copy(alpha = 0f), colors.surface)))
                .padding(start = 16.dp, end = 16.dp, bottom = 12.dp),
            contentAlignment = Alignment.BottomCenter,
        ) {
            DocumentName(name, d.size)
        }
        if (pdf != null) {
            // On top of the preview: a tap opens the PDF instead of scrolling its pages. TalkBack
            // reads it as one button: "Open the PDF, <name>".
            Box(
                Modifier.matchParentSize()
                    .clickable(onClickLabel = openLabel, role = Role.Button) { platform.openPdf(pdf) }
                    .semantics { contentDescription = "$openLabel, $name" },
            )
            Box(
                Modifier.align(Alignment.TopEnd).padding(12.dp).background(colors.fgSubtle, CircleShape)
                    .padding(horizontal = 12.dp, vertical = 8.dp),
            ) {
                Icon(LineIcons.OpenOutside, contentDescription = null, tint = colors.surface, modifier = Modifier.size(14.dp))
            }
        }
    }
}

/** A document's name and size, read as one item. */
@Composable
private fun DocumentName(name: String, size: Long, modifier: Modifier = Modifier) {
    Row(
        modifier.semantics(mergeDescendants = true) {},
        horizontalArrangement = Arrangement.spacedBy(8.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Text(
            name, Modifier.weight(1f, fill = false),
            fontSize = 16.sp, fontWeight = FontWeight.SemiBold, color = colors.fg, lineHeight = 24.sp,
            maxLines = 1, overflow = TextOverflow.Ellipsis,
        )
        Text(formatSize(size), fontSize = 13.sp, color = colors.fgSubtle, lineHeight = 24.sp)
    }
}

/** The card refused the CAN or the PIN (or none came): the user types it on the computer. */
@Composable
private fun WaitStep(step: Step.WaitForComputer, actions: FirmaActions, canCancel: Boolean, away: @Composable () -> Unit) {
    val pin = step.what == Need.Pin
    val left = step.triesLeft
    val title = stringResource(if (pin) Res.string.wait_pin_title else Res.string.wait_can_title)
    Layout(hero = { ComputerIllustration() }, pane = title) {
        Words {
            Title(title)
            if (pin && !step.refused && left != 1) Body(stringResource(Res.string.wait_pin_missing))
            Row(horizontalArrangement = Arrangement.spacedBy(10.dp), verticalAlignment = Alignment.CenterVertically) {
                // The spinner only says "waiting": decorative, the text says it.
                CircularProgressIndicator(Modifier.size(16.dp).clearAndSetSemantics {}, color = colors.fgSubtle, strokeWidth = 2.dp)
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
    val title = stringResource(message)
    Layout(hero = { ResultIcon(tone) }, pane = title) {
        Words { Title(title) }
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
