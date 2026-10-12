package es.spainassist.firma

import androidx.compose.runtime.Composable
import es.spainassist.firma.app.FirmaController
import es.spainassist.firma.app.Licenses
import es.spainassist.firma.app.Outcome
import es.spainassist.firma.app.Platform
import es.spainassist.firma.app.Screen
import es.spainassist.firma.app.SecureStore
import es.spainassist.firma.app.StartNotice
import es.spainassist.firma.app.Step
import es.spainassist.firma.card.Card
import es.spainassist.firma.card.CardException
import es.spainassist.firma.card.CardReader
import es.spainassist.firma.card.DnieSession
import es.spainassist.firma.card.NfcAvailability
import es.spainassist.firma.protocol.Algorithm
import es.spainassist.firma.relay.LinkStatus
import es.spainassist.firma.relay.RelayEvents
import es.spainassist.firma.relay.RelaySocket
import io.ktor.client.HttpClient
import io.ktor.client.engine.cio.CIO
import io.ktor.client.plugins.websocket.WebSockets
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.newSingleThreadContext
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.withContext
import kotlinx.coroutines.withTimeout
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import java.io.File
import java.security.KeyFactory
import java.security.Signature
import java.security.spec.PKCS8EncodedKeySpec
import java.util.Base64
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertTrue

/**
 * The real phone stack (controller, PhoneLink, RelaySocket over ktor) against the real desktop
 * stack (DesktopPairing, PhoneSigner, @sa/signer's AutoFirma handler) through the real relay.
 * `services/relay-server/scripts/interop.ts` starts the desktop side and runs this test with
 * `-Pinterop=<config.json>`; a software RSA key stands in for the DNIe. Skipped otherwise.
 * The desktop sends the card's CAN and PIN with some requests and wrong ones with another: the
 * phone must ask for each exactly once, after the wrong one, and try the wrong PIN only once.
 */
class InteropTest {
    @OptIn(ExperimentalCoroutinesApi::class)
    @Test
    fun signsWithTheDesktop() {
        val path = System.getProperty("interop.config") ?: return println("InteropTest skipped: no -Pinterop")
        val config = Json.parseToJsonElement(File(path).readText()).jsonObject
        val link = config.getValue("link").jsonPrimitive.content
        val certificate = Base64.getDecoder().decode(config.getValue("certificate").jsonPrimitive.content)
        val cardCan = config.getValue("can").jsonPrimitive.content
        val cardPin = config.getValue("pin").jsonPrimitive.content
        val triedCans = ArrayList<String>()
        val triedPins = ArrayList<String>()
        var pinTries = 3
        val key = KeyFactory.getInstance("RSA").generatePrivate(
            PKCS8EncodedKeySpec(Base64.getDecoder().decode(config.getValue("privateKey").jsonPrimitive.content)),
        )

        val thread = newSingleThreadContext("controller")
        val scope = CoroutineScope(thread)
        val client = HttpClient(CIO) { install(WebSockets) }
        val card = object : Card {
            override fun open(can: String, purpose: es.spainassist.firma.protocol.Purpose, pin: () -> String): DnieSession {
                triedCans += can
                if (can != cardCan) throw CardException.WrongCan()
                return object : DnieSession {
                    override val certificates = listOf(certificate)

                    override fun sign(data: ByteArray, algorithm: Algorithm, prehashed: Boolean): ByteArray {
                        val typed = pin()
                        triedPins += typed
                        if (typed != cardPin) throw CardException.WrongPin(--pinTries)
                        pinTries = 3
                        if (prehashed) {
                            val prefix = when (algorithm) {
                                Algorithm.Sha1 -> "3021300906052b0e03021a05000414"
                                Algorithm.Sha256 -> "3031300d060960864801650304020105000420"
                                Algorithm.Sha384 -> "3041300d060960864801650304020205000430"
                                Algorithm.Sha512 -> "3051300d060960864801650304020305000440"
                            }.chunked(2).map { it.toInt(16).toByte() }.toByteArray()
                            return javax.crypto.Cipher.getInstance("RSA/ECB/PKCS1Padding").run {
                                init(javax.crypto.Cipher.ENCRYPT_MODE, key)
                                doFinal(prefix + data)
                            }
                        }
                        return Signature.getInstance(algorithm.jcaName).run {
                            initSign(key)
                            update(data)
                            sign()
                        }
                    }
                }
            }

            override fun close() = Unit
        }
        val platform = object : Platform {
            override val appVersion = "1.0.0-interop"
            override val deviceName = "Interop phone"
            override val platformName = "android"
            override val allowInsecureRelay = true
            override val store = object : SecureStore {
                val values = HashMap<String, String>()

                override fun get(key: String) = values[key]

                override fun put(key: String, value: String) {
                    values[key] = value
                }

                override fun remove(key: String) {
                    values.remove(key)
                }
            }
            override val cardReader = object : CardReader {
                override val nfc = MutableStateFlow(NfcAvailability.Ready)

                override suspend fun awaitCard(): Card = card
            }

            override fun relay(relayUrl: String, room: String, events: RelayEvents) =
                RelaySocket(client, relayUrl, room, scope, events)

            override fun now() = System.currentTimeMillis()

            override fun openNfcSettings() = Unit

            override fun log(message: String) = println("phone: $message")

            @Composable
            override fun QrScanner(onCode: (String) -> Unit) = Unit

            @Composable
            override fun PdfPreview(pdf: ByteArray) = Unit

            override val licenses = Licenses(eupl = false, groups = emptyList(), proprietary = emptyList())

            override fun bundledNotices() = emptyList<Pair<String, String>>()

            @Composable
            override fun BackHandler(onBack: () -> Unit) = Unit
        }

        val outcomes = ArrayList<Outcome>()
        val canSteps = ArrayList<Step.EnterCan>()
        val pinSteps = ArrayList<Step.EnterPin>()
        runBlocking<Unit> {
            val controller = withContext(thread) { FirmaController(platform, scope) }
            controller.onLink(link)
            withTimeout(10_000) { while (controller.screen.value !is Screen.ConfirmPairing) delay(20) }
            controller.confirmPairing()
            // Connected: home, or straight to the first request the desktop had queued.
            withTimeout(20_000) {
                while (true) {
                    val screen = controller.screen.value
                    if (screen is Screen.Signing || (screen as? Screen.Home)?.link is LinkStatus.Connected) break
                    delay(5)
                }
            }
            println("phone: paired")
            // Answer every step until the desktop, done with its signatures, unpairs.
            withTimeout(180_000) {
                var last: Any? = null
                while (true) {
                    val screen = controller.screen.value
                    if (screen is Screen.Start) break
                    val step = (screen as? Screen.Signing)?.step
                    if (step != last) {
                        println("phone: $step")
                        last = step
                        when (step) {
                            Step.Review -> controller.approve()
                            is Step.EnterCan -> {
                                canSteps += step
                                controller.submitCan(cardCan)
                            }
                            is Step.EnterPin -> {
                                pinSteps += step
                                controller.submitPin(cardPin)
                            }
                            is Step.Result -> outcomes += step.outcome
                            else -> Unit
                        }
                    }
                    delay(5)
                }
            }
            assertEquals(StartNotice.DesktopUnpaired, (controller.screen.value as Screen.Start).notice)
        }
        client.close()
        thread.close()
        // The desktop checks every signature; here, nothing may have failed on the phone.
        assertTrue(outcomes.none { it is Outcome.Failed }, "phone outcomes: $outcomes")
        // The first request's CAN came from the desktop; only its wrong one made the phone ask.
        assertEquals(cardCan, triedCans.first())
        assertEquals(listOf(Step.EnterCan(wrong = true, fromComputer = true)), canSteps)
        // The same for the PIN: the desktop's was used first, and its wrong one cost one try.
        assertEquals(cardPin, triedPins.first())
        assertEquals(1, triedPins.count { it != cardPin }, "tried PINs: ${triedPins.size}")
        assertEquals(listOf(Step.EnterPin(wrong = true, retriesLeft = 2, fromComputer = true)), pinSteps)
    }
}
