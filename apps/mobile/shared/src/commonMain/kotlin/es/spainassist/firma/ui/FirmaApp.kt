package es.spainassist.firma.ui

import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
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
import androidx.compose.material3.Button
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.Icon
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
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.lifecycle.compose.collectAsStateWithLifecycle
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
    var licenses by rememberSaveable { mutableStateOf(false) }
    val idle = screen is Screen.Start || screen is Screen.Home
    // A pairing or a request takes over; afterwards the app is back on its own screen.
    LaunchedEffect(idle) { if (!idle) licenses = false }
    FirmaTheme {
        Surface(modifier = Modifier.fillMaxSize(), color = MaterialTheme.colorScheme.background) {
            Box(Modifier.safeDrawingPadding()) {
                val openLicenses = { licenses = true }
                if (licenses && idle) {
                    LicensesScreen(platform) { licenses = false }
                } else {
                    when (val s = screen) {
                        is Screen.Start -> StartScreen(s, controller, platform, openLicenses)
                        is Screen.ConfirmPairing -> ConfirmPairingScreen(s, controller)
                        is Screen.Home -> HomeScreen(s, controller, openLicenses)
                        is Screen.Signing -> SigningScreen(s, controller, platform)
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

@Composable
internal fun Page(content: @Composable () -> Unit) {
    Column(
        modifier = Modifier.fillMaxSize().verticalScroll(rememberScrollState()).padding(horizontal = 20.dp, vertical = 24.dp),
        verticalArrangement = Arrangement.spacedBy(16.dp),
    ) { content() }
}

@Composable
internal fun Title(text: String) {
    Text(text, fontSize = 24.sp, fontWeight = FontWeight.SemiBold, color = colors.fg, lineHeight = 30.sp)
}

@Composable
internal fun Body(text: String, color: Color = colors.fgMuted) {
    Text(text, fontSize = 16.sp, color = color, lineHeight = 22.sp)
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
        Text(text, fontSize = 16.sp, color = colors.fg)
    }
}

@Composable
private fun NfcBanner(nfc: NfcAvailability, controller: FirmaController) {
    when (nfc) {
        NfcAvailability.Missing -> Banner(stringResource(Res.string.nfc_missing), Tone.Blocked)
        NfcAvailability.Disabled -> Banner(stringResource(Res.string.nfc_disabled), Tone.Attention) {
            TextButton(onClick = controller::openNfcSettings) { Text(stringResource(Res.string.nfc_open_settings)) }
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
            Text("DNIe", modifier = Modifier.padding(12.dp), color = colors.accentText, fontWeight = FontWeight.Bold)
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

// ---------------------------------------------------------------------------------------------
// Start, pairing, home
// ---------------------------------------------------------------------------------------------

@Composable
private fun StartScreen(s: Screen.Start, controller: FirmaController, platform: Platform, openLicenses: () -> Unit) {
    var scanning by rememberSaveable { mutableStateOf(false) }
    if (scanning) {
        Column(Modifier.fillMaxSize().padding(20.dp), verticalArrangement = Arrangement.spacedBy(16.dp)) {
            Title(stringResource(Res.string.scan_title))
            Box(Modifier.fillMaxWidth().weight(1f).background(Color.Black, RoundedCornerShape(16.dp))) {
                platform.QrScanner { code ->
                    scanning = false
                    controller.onLink(code)
                }
            }
            Secondary(stringResource(Res.string.scan_cancel)) { scanning = false }
        }
        return
    }
    Page {
        Title(stringResource(Res.string.start_title))
        Body(stringResource(Res.string.start_lead))
        when (s.notice) {
            StartNotice.BadLink -> Banner(stringResource(Res.string.notice_bad_link), Tone.Attention)
            StartNotice.PairingEnded -> Banner(stringResource(Res.string.notice_ended), Tone.Info)
            StartNotice.PairingExpired -> Banner(stringResource(Res.string.notice_expired), Tone.Info)
            StartNotice.Replaced -> Banner(stringResource(Res.string.notice_replaced), Tone.Attention)
            StartNotice.DesktopUnpaired -> Banner(stringResource(Res.string.notice_desktop_unpaired), Tone.Info)
            null -> Unit
        }
        NfcBanner(s.nfc, controller)
        listOf(Res.string.start_step1, Res.string.start_step2, Res.string.start_step3).forEachIndexed { i, step ->
            Row(horizontalArrangement = Arrangement.spacedBy(12.dp), verticalAlignment = Alignment.Top) {
                Box(Modifier.size(28.dp).background(colors.accentSoft, CircleShape), contentAlignment = Alignment.Center) {
                    Text("${i + 1}", color = colors.accentText, fontWeight = FontWeight.SemiBold)
                }
                Body(stringResource(step), colors.fg)
            }
        }
        Body(stringResource(Res.string.start_need))
        Spacer(Modifier.height(4.dp))
        Primary(stringResource(Res.string.start_scan), onClick = { scanning = true }, enabled = s.nfc != NfcAvailability.Missing)
        TextButton(onClick = openLicenses) { Text(stringResource(Res.string.licenses_open)) }
    }
}

@Composable
private fun ConfirmPairingScreen(s: Screen.ConfirmPairing, controller: FirmaController) {
    Page {
        Title(stringResource(Res.string.pair_title))
        Body(stringResource(Res.string.pair_body))
        if (s.replacing) Banner(stringResource(Res.string.pair_replacing), Tone.Attention)
        Primary(stringResource(Res.string.pair_confirm), onClick = { controller.confirmPairing() })
        Secondary(stringResource(Res.string.pair_cancel)) { controller.cancelPairing() }
    }
}

@Composable
private fun HomeScreen(s: Screen.Home, controller: FirmaController, openLicenses: () -> Unit) {
    Page {
        Title(stringResource(Res.string.app_name))
        when (s.link) {
            is LinkStatus.Connected -> Banner(stringResource(Res.string.home_connected), Tone.Done)
            LinkStatus.DesktopAway -> Banner(stringResource(Res.string.home_away), Tone.Attention)
            is LinkStatus.Outdated -> Banner(stringResource(Res.string.home_outdated), Tone.Blocked)
            else -> Banner(stringResource(Res.string.home_connecting), Tone.Info)
        }
        NfcBanner(s.nfc, controller)
        Body(stringResource(Res.string.home_waiting))
        Spacer(Modifier.height(8.dp))
        Secondary(stringResource(Res.string.home_unpair)) { controller.unpair() }
        TextButton(onClick = openLicenses) { Text(stringResource(Res.string.licenses_open)) }
    }
}

// ---------------------------------------------------------------------------------------------
// Signing
// ---------------------------------------------------------------------------------------------

@Composable
private fun SigningScreen(s: Screen.Signing, controller: FirmaController, platform: Platform) {
    Page {
        if (!s.connected && s.step !is Step.Result) Banner(stringResource(Res.string.review_disconnected), Tone.Info)
        when (val step = s.step) {
            Step.Review -> ReviewStep(s.request, s.nfc, controller, platform)
            is Step.WaitForComputer -> WaitStep(step, controller, s.request.purpose != Purpose.Login)
            is Step.HoldCard -> {
                Title(stringResource(Res.string.card_title))
                NfcBanner(s.nfc, controller)
                if (step.moved) Banner(stringResource(Res.string.card_moved), Tone.Attention)
                CardIllustration(active = false)
                Body(stringResource(Res.string.card_body))
                if (s.request.purpose != Purpose.Login) Secondary(stringResource(Res.string.cancel_label)) { controller.cancel() }
            }
            is Step.Working -> {
                Title(stringResource(if (s.request.purpose == Purpose.Login) Res.string.working_login else if (step.reading) Res.string.working_reading else Res.string.working_signing))
                CardIllustration(active = true)
                Body(stringResource(Res.string.working_hint), colors.fg)
                if (s.request.purpose == Purpose.Login) Body(stringResource(Res.string.login_cancel_desktop))
                else if (step.signed > 0) Body(stringResource(Res.string.working_signed, step.signed))
            }
            is Step.Result -> ResultStep(step.outcome, controller, s.request.purpose == Purpose.Login)
        }
    }
}

@Composable
private fun ReviewStep(r: Review, nfc: NfcAvailability, controller: FirmaController, platform: Platform) {
    val certificateOnly = r.purpose == Purpose.Certificate
    val login = r.purpose == Purpose.Login
    Title(stringResource(if (login) Res.string.review_title_login else if (certificateOnly) Res.string.review_title_certificate else Res.string.review_title, r.host))
    NfcBanner(nfc, controller)
    if (login) {
        Body(stringResource(Res.string.review_login_body))
    } else if (certificateOnly) {
        Body(stringResource(Res.string.review_certificate_body))
    } else {
        Text(r.description, color = colors.fg, fontSize = 15.sp, lineHeight = 21.sp)
        r.signatures?.takeIf { it > 1 }?.let { Body(stringResource(Res.string.review_signatures, it)) }
        r.documents.forEach { DocumentPreview(it, platform) }
        if (r.verifiable) {
            Banner(stringResource(Res.string.review_checked), Tone.Done)
        } else {
            Banner(stringResource(Res.string.review_unchecked), Tone.Info)
        }
    }
    Primary(
        stringResource(if (login) Res.string.review_login else if (certificateOnly) Res.string.review_share else Res.string.review_sign),
        onClick = { controller.approve() },
    )
    Secondary(stringResource(Res.string.review_decline)) { controller.decline() }
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
private fun WaitStep(step: Step.WaitForComputer, controller: FirmaController, canCancel: Boolean) {
    val pin = step.what == Need.Pin
    Title(stringResource(if (pin) Res.string.wait_pin_title else Res.string.wait_can_title))
    val left = step.triesLeft
    when {
        !pin -> Banner(stringResource(Res.string.wait_can_wrong), Tone.Attention)
        left == 1 -> Banner(stringResource(Res.string.pin_last_try), Tone.Blocked)
        step.refused && left != null -> Banner(stringResource(Res.string.wait_pin_wrong, left), Tone.Attention)
        else -> Body(stringResource(Res.string.wait_pin_missing), colors.fg)
    }
    Row(horizontalArrangement = Arrangement.spacedBy(10.dp), verticalAlignment = Alignment.CenterVertically) {
        CircularProgressIndicator(Modifier.size(18.dp), strokeWidth = 2.dp)
        Body(stringResource(Res.string.wait_body))
    }
    if (canCancel) Secondary(stringResource(Res.string.cancel_label)) { controller.cancel() }
}

@Composable
private fun ResultStep(outcome: Outcome, controller: FirmaController, login: Boolean) {
    val (message, tone) = when (outcome) {
        Outcome.Signed -> (if (login) Res.string.result_login else Res.string.result_signed) to Tone.Done
        Outcome.CertificateShared -> Res.string.result_certificate to Tone.Done
        Outcome.Declined -> (if (login) Res.string.result_login_declined else Res.string.result_declined) to Tone.Info
        Outcome.Cancelled -> Res.string.result_cancelled to Tone.Info
        Outcome.CancelledByDesktop -> (if (login) Res.string.result_login_cancelled else Res.string.result_cancelled_desktop) to Tone.Info
        Outcome.Expired -> Res.string.result_expired to Tone.Attention
        is Outcome.Failed -> failure(outcome.code, login) to Tone.Blocked
    }
    Spacer(Modifier.height(24.dp))
    val icon: ImageVector = if (tone == Tone.Done) Icons.Filled.CheckCircle else if (tone == Tone.Blocked) Icons.Filled.Warning else Icons.Filled.Info
    val tint = when (tone) {
        Tone.Done -> colors.doneFg
        Tone.Blocked -> colors.blockedFg
        Tone.Attention -> colors.attentionFg
        Tone.Info -> colors.fgSubtle
    }
    Box(Modifier.fillMaxWidth(), contentAlignment = Alignment.Center) {
        Icon(icon, contentDescription = null, tint = tint, modifier = Modifier.size(56.dp))
    }
    Text(stringResource(message), color = colors.fg, fontSize = 20.sp, lineHeight = 26.sp, fontWeight = FontWeight.Medium)
    Primary(stringResource(Res.string.result_ok), onClick = { controller.dismissResult() })
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
