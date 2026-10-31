package es.spainassist.firma.android

import android.graphics.Paint
import android.graphics.pdf.PdfDocument
import android.os.Bundle
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.activity.enableEdgeToEdge
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.runtime.Composable
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.core.view.WindowCompat
import androidx.core.view.WindowInsetsCompat
import es.spainassist.firma.app.FirmaActions
import es.spainassist.firma.app.Outcome
import es.spainassist.firma.app.Platform
import es.spainassist.firma.app.Review
import es.spainassist.firma.app.ReviewDocument
import es.spainassist.firma.app.Screen
import es.spainassist.firma.app.StartNotice
import es.spainassist.firma.app.Step
import es.spainassist.firma.card.NfcAvailability
import es.spainassist.firma.channel.PairingLink
import es.spainassist.firma.protocol.ErrorCode
import es.spainassist.firma.protocol.Need
import es.spainassist.firma.protocol.Purpose
import es.spainassist.firma.protocol.Welcome
import es.spainassist.firma.relay.LinkStatus
import es.spainassist.firma.ui.FirmaScreens
import es.spainassist.firma.ui.Overlay
import java.io.ByteArrayOutputStream

/**
 * Debug builds only: one screen with mock data and no controller, for screenshots and design
 * checks (apps/mobile/README.md). `adb shell am start -n es.spainassist.firma.debug/es.spainassist.firma.android.PreviewActivity --es screen conectado`
 */
class PreviewActivity : ComponentActivity() {
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        enableEdgeToEdge()
        // Like the design frames: a status bar and no navigation bar.
        WindowCompat.getInsetsController(window, window.decorView).hide(WindowInsetsCompat.Type.navigationBars())
        val name = intent.getStringExtra("screen") ?: "inicio"
        val preview = previews()[name] ?: error("Unknown screen $name: ${previews().keys}")
        val platform = PreviewPlatform((application as FirmaApplication).platform)
        setContent { FirmaScreens(preview.screen, NoActions, platform, preview.overlay) }
    }

    private class Preview(val screen: Screen, val overlay: Overlay? = null)

    private fun previews(): Map<String, Preview> {
        val ready = NfcAvailability.Ready
        val document = review(Purpose.Document)
        val login = review(Purpose.Login)
        val pdf = samplePdf()
        val several = document.copy(
            documents = listOf("Modelo 030.pdf", "Justificante de domicilio.pdf").map { ReviewDocument(it, "application/pdf", pdf.size.toLong(), "0".repeat(64), pdf) },
            signatures = 2,
        )
        fun signing(r: Review, step: Step) = Preview(Screen.Signing(ready, r, step, connected = true))
        return mapOf(
            "inicio" to Preview(Screen.Start(ready)),
            "inicio-sin-nfc" to Preview(Screen.Start(NfcAvailability.Missing)),
            "inicio-nfc-desactivado" to Preview(Screen.Start(NfcAvailability.Disabled)),
            "vinculacion-terminada" to Preview(Screen.Start(ready, StartNotice.PairingEnded)),
            "escanear" to Preview(Screen.Start(ready), Overlay.Scanner),
            "licencias" to Preview(Screen.Start(ready), Overlay.Licenses),
            "vincular" to Preview(Screen.ConfirmPairing(ready, PAIRING)),
            "conectado" to Preview(Screen.Home(ready, LinkStatus.Connected(Welcome("welcome", 1, "desktop", "2026-10-15T09:41:00Z")))),
            "ordenador-desconectado" to Preview(Screen.Home(ready, LinkStatus.DesktopAway)),
            "revisar" to signing(document, Step.Review),
            "revisar-desconocido" to signing(document.copy(official = false), Step.Review),
            "revisar-varios" to signing(several, Step.Review),
            "certificado-revisar" to signing(review(Purpose.Certificate), Step.Review),
            "pin-pedir" to signing(document, Step.WaitForComputer(Need.Pin, refused = false, triesLeft = null)),
            "pin" to signing(document, Step.WaitForComputer(Need.Pin, refused = true, triesLeft = 2)),
            "acerca" to signing(document, Step.HoldCard(moved = false)),
            "movido" to signing(document, Step.HoldCard(moved = true)),
            "leyendo" to signing(document, Step.Working(reading = true, signed = 0)),
            "firmado" to signing(document, Step.Result(Outcome.Signed)),
            "pin-bloqueado" to signing(document, Step.Result(Outcome.Failed(ErrorCode.PinBlocked))),
            "sin-nfc" to signing(document, Step.Result(Outcome.Failed(ErrorCode.NfcUnavailable))),
            "tiempo" to signing(document, Step.Result(Outcome.Expired)),
            "entrar-revisar" to signing(login, Step.Review),
            "entrar-revisar-desconocido" to signing(login.copy(official = false), Step.Review),
            "entrar-acerca" to signing(login, Step.HoldCard(moved = false)),
            "entrar-cerca" to signing(login, Step.Working(reading = false, signed = 0)),
            "entrar-terminado" to signing(login, Step.Result(Outcome.Signed)),
            "entrar-no-aprobado" to signing(login, Step.Result(Outcome.Declined)),
            "entrar-cancelado" to signing(login, Step.Result(Outcome.CancelledByDesktop)),
            "entrar-error" to signing(login, Step.Result(Outcome.Failed(ErrorCode.Internal))),
        )
    }

    private fun review(purpose: Purpose): Review {
        val pdf = samplePdf()
        return Review(
            requestId = "preview",
            purpose = purpose,
            host = "sede.agenciatributaria.gob.es",
            format = "pades",
            documents = if (purpose == Purpose.Document) listOf(ReviewDocument(null, "application/pdf", pdf.size.toLong(), "0".repeat(64), pdf)) else emptyList(),
            verifiable = purpose == Purpose.Document,
            signatures = 1,
        )
    }

    /** A made-up form with mock data. */
    private fun samplePdf(): ByteArray {
        val doc = PdfDocument()
        val page = doc.startPage(PdfDocument.PageInfo.Builder(595, 842, 1).create())
        val paint = Paint().apply { textSize = 11f }
        listOf(
            "Modelo 030 · Cambio de domicilio fiscal",
            "Nombre: Lucía Martín Ortega",
            "NIF: 12345678Z",
            "Nuevo domicilio: Calle de Alcalá 123, 4.º B",
            "28009 Madrid",
            "Fecha: 11 de octubre de 2026",
        ).forEachIndexed { i, line -> page.canvas.drawText(line, 56f, 80f + i * 20f, paint) }
        doc.finishPage(page)
        return ByteArrayOutputStream().also { doc.writeTo(it); doc.close() }.toByteArray()
    }

    private object NoActions : FirmaActions {
        override fun onLink(text: String) = Unit
        override fun confirmPairing() = Unit
        override fun cancelPairing() = Unit
        override fun unpair() = Unit
        override fun openNfcSettings() = Unit
        override fun approve() = Unit
        override fun decline() = Unit
        override fun cancel() = Unit
        override fun dismissResult() = Unit
    }

    /** The real platform, with a still viewfinder instead of the camera. */
    private class PreviewPlatform(real: Platform) : Platform by real {
        @Composable
        override fun QrScanner(onCode: (String) -> Unit) {
            Box(Modifier.fillMaxSize().background(Color(0xFF3A3532)))
        }
    }

    private companion object {
        val PAIRING = PairingLink("wss://relay.example", ByteArray(16), ByteArray(32), ByteArray(65))
    }
}
