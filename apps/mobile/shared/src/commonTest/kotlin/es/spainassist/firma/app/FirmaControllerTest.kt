package es.spainassist.firma.app

import es.spainassist.firma.VECTORS_JSON
import es.spainassist.firma.card.CardException
import es.spainassist.firma.channel.Base64Std
import es.spainassist.firma.protocol.Algorithm
import es.spainassist.firma.protocol.Check
import es.spainassist.firma.protocol.CompanionDocument
import es.spainassist.firma.protocol.CompanionJson
import es.spainassist.firma.protocol.ErrorCode
import es.spainassist.firma.protocol.PhoneBye
import es.spainassist.firma.protocol.Purpose
import es.spainassist.firma.protocol.SignCancel
import es.spainassist.firma.protocol.CancelReason
import es.spainassist.firma.protocol.SignCertificate
import es.spainassist.firma.protocol.SignDone
import es.spainassist.firma.protocol.SignError
import es.spainassist.firma.protocol.SignProgress
import es.spainassist.firma.protocol.SignRequest
import es.spainassist.firma.protocol.SignSignature
import es.spainassist.firma.protocol.SignNeed
import es.spainassist.firma.protocol.SignUnlock
import es.spainassist.firma.protocol.Need
import es.spainassist.firma.protocol.DesktopToPhone
import es.spainassist.firma.protocol.Stage
import es.spainassist.firma.protocol.ToBeSigned
import es.spainassist.firma.relay.LinkStatus
import kotlinx.coroutines.test.TestScope
import kotlinx.coroutines.test.UnconfinedTestDispatcher
import kotlinx.coroutines.test.advanceTimeBy
import kotlinx.coroutines.test.runCurrent
import kotlinx.coroutines.test.runTest
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import kotlin.test.Test
import kotlin.test.assertContentEquals
import kotlin.test.assertEquals
import kotlin.test.assertFails
import kotlin.test.assertFalse
import kotlin.test.assertIs
import kotlin.test.assertNull
import kotlin.test.assertTrue
import kotlin.time.ExperimentalTime
import kotlin.time.Instant

private fun Screen.step(): Step? = (this as? Screen.Signing)?.step

@OptIn(ExperimentalTime::class)
class FirmaControllerTest {
    /** The CAdES case of the vectors: a document and the signed attributes @sa/signer builds. */
    private val cms = Json.parseToJsonElement(VECTORS_JSON).jsonObject.getValue("bindings").jsonObject.getValue("cms").jsonObject

    private fun field(o: JsonObject, name: String) = o.getValue(name).jsonPrimitive.content

    private class Harness(scope: TestScope) {
        val platform = FakePlatform()
        val spy = LinkSpy()
        val dispatcher = UnconfinedTestDispatcher(scope.testScheduler)
        val controller = FirmaController(platform, TestScope(dispatcher), dispatcher, spy.factory)
        val reader get() = platform.cardReader
        val screen get() = controller.screen.value
        val link get() = spy.last

        fun pairAndConnect() {
            controller.onLink(testLink())
            controller.confirmPairing()
            link.connect()
        }

        fun request(
            id: String = "6f1c3b9e-2d4a-4f8b-9c1d-5e7a2b3c4d5e",
            documents: List<CompanionDocument> = emptyList(),
            verifiable: Boolean = false,
            purpose: Purpose = Purpose.Document,
            expiresIn: Long = 5 * 60_000,
            can: String = "123456",
            pin: String? = "secreto1",
        ) = SignRequest(
            requestId = id,
            purpose = purpose,
            origin = "https://sede.example.gob.es",
            description = "Firmar solicitud.pdf",
            format = if (purpose == Purpose.Login) "" else "CAdES",
            documents = documents,
            verifiable = verifiable,
            expiresAt = Instant.fromEpochMilliseconds(platform.clock + expiresIn).toString(),
            can = can,
            pin = pin,
        )

        /** Approve and hold [card]: up to the certificate. */
        fun approveWith(card: FakeCard) {
            controller.approve()
            reader.present(card)
        }

        fun unlock(id: String, can: String? = null, pin: String? = null) = link.deliver(
            SignUnlock(id, can = can, pin = pin, expiresAt = Instant.fromEpochMilliseconds(platform.clock + 5 * 60_000).toString()),
        )
    }

    /** A card whose PIN is [right]: it counts its tries down like a DNIe and records each PIN. */
    private class PinCard(val right: String, var tries: Int = 3) {
        val tried = ArrayList<String>()
        val card = FakeCard(onSign = { _, pin ->
            tried += pin
            when {
                tries <= 0 -> CardException.PinBlocked()
                pin != right -> if (--tries == 0) CardException.PinBlocked() else CardException.WrongPin(tries)
                else -> null.also { tries = 3 }
            }
        })
    }

    @Test
    fun loginUsesAuthenticationCertificateAndSignsDigestOnce() = runTest {
        val h = Harness(this)
        h.pairAndConnect()
        val vectors = Json.parseToJsonElement(VECTORS_JSON).jsonObject.getValue("login").jsonObject
        val request = CompanionJson.decodeFromString<es.spainassist.firma.protocol.DesktopToPhone>(vectors.getValue("request").toString()) as SignRequest
        assertEquals("123456", request.can)
        assertEquals("12345678", request.pin)
        // The need as the desktop decodes it, and its answer.
        assertEquals(
            vectors.getValue("need"),
            Json.parseToJsonElement(
                CompanionJson.encodeToString(
                    es.spainassist.firma.protocol.PhoneToDesktop.serializer(),
                    SignNeed(request.requestId, Need.Pin, refused = true, triesLeft = 2),
                ),
            ),
        )
        val unlock = CompanionJson.decodeFromString<DesktopToPhone>(vectors.getValue("unlock").toString()) as SignUnlock
        assertEquals("87654321", unlock.pin)
        assertNull(unlock.can)
        h.link.deliver(request)
        val card = FakeCard()
        h.approveWith(card)
        assertEquals(Purpose.Login, card.purposeRead)
        h.controller.cancel()
        assertTrue(h.screen.step() !is Step.Result)
        val tbs = CompanionJson.decodeFromString<es.spainassist.firma.protocol.DesktopToPhone>(vectors.getValue("toBeSigned").toString()) as ToBeSigned
        h.link.deliver(tbs)
        assertTrue(card.digestSigned)
        assertEquals(32, card.signed.single().size)
        h.link.deliver(tbs)
        assertEquals(1, card.signed.size)
        h.link.deliver(SignDone(request.requestId))
        assertIs<Step.Result>(h.screen.step())
    }

    @Test
    fun rejectsUnhashedLoginAndPrehashedDocuments() = runTest {
        for (purpose in listOf(Purpose.Login, Purpose.Document)) {
            val h = Harness(this)
            h.pairAndConnect()
            val request = h.request(purpose = purpose)
            h.link.deliver(request)
            val card = FakeCard()
            h.approveWith(card)
            h.link.deliver(ToBeSigned(request.requestId, 1, Algorithm.Sha256, "Bw==", prehashed = purpose == Purpose.Document))
            assertEquals(0, card.signed.size)
            assertEquals(ErrorCode.Protocol, h.link.sent.filterIsInstance<SignError>().last().code)
        }
    }

    @Test
    fun warnsAboutSitesTheDesktopDoesNotRecogniseOnly() = runTest {
        for ((official, shown) in listOf(true to true, false to false, null to true)) {
            val h = Harness(this)
            h.pairAndConnect()
            h.link.deliver(h.request().copy(official = official))
            assertEquals(shown, (h.screen as Screen.Signing).request.official, "official=$official")
        }
    }

    @Test
    fun signsNoMoreThanTheSignaturesTheReviewShowed() = runTest {
        val h = Harness(this)
        h.pairAndConnect()
        val request = h.request().copy(signatures = 2)
        h.link.deliver(request)
        val card = FakeCard()
        h.approveWith(card)
        for (seq in 1..2) h.link.deliver(ToBeSigned(request.requestId, seq, Algorithm.Sha256, "Bw=="))
        // A re-sent item is answered again, but a third one is refused.
        h.link.deliver(ToBeSigned(request.requestId, 2, Algorithm.Sha256, "Bw=="))
        h.link.deliver(ToBeSigned(request.requestId, 3, Algorithm.Sha256, "Bw=="))
        assertEquals(2, card.signed.size)
        assertEquals(listOf(1, 2, 2), h.link.sentOf<SignSignature>().map { it.seq })
        assertEquals(ErrorCode.Protocol, h.link.sentOf<SignError>().single().code)
        assertEquals(Step.Result(Outcome.Failed(ErrorCode.Protocol)), h.screen.step())

        // A count below one is refused before the review.
        h.controller.dismissResult()
        h.link.deliver(h.request(id = "2f1c3b9e-2d4a-4f8b-9c1d-5e7a2b3c4d5e").copy(signatures = 0))
        assertEquals(ErrorCode.Protocol, h.link.sentOf<SignError>().last().code)
        assertTrue(h.screen.step() == null)
    }

    @Test
    fun pairsRemembersAndRestoresThePairing() = runTest {
        val h = Harness(this)
        h.controller.onLink("https://example.com/not-a-pairing")
        assertEquals(StartNotice.BadLink, (h.screen as Screen.Start).notice)
        h.controller.onLink(testLink())
        assertIs<Screen.ConfirmPairing>(h.screen)
        h.controller.confirmPairing()
        assertIs<Screen.Home>(h.screen)
        assertEquals("Test phone", h.spy.hellos.single().device)
        // The first WELCOME carries the pairing's own secret, which replaces the QR's.
        val session = ByteArray(32) { 5 }
        h.link.connect(session = Base64Std.encode(session))
        assertIs<LinkStatus.Connected>((h.screen as Screen.Home).link)
        assertTrue(h.platform.store.values.containsKey(FirmaController.KEY_PAIRING))

        // A new process: the pairing comes back on its own, with the pairing's secret.
        val spy = LinkSpy()
        val again = FirmaController(h.platform, TestScope(h.dispatcher), h.dispatcher, spy.factory)
        assertIs<Screen.Home>(again.screen.value)
        assertEquals(1, spy.last.started)
        assertContentEquals(session, spy.last.pairing.secret)
        // The same QR again is the same pairing: no new one, and the stored secret stays.
        again.onLink(testLink())
        assertIs<Screen.Home>(again.screen.value)
        assertEquals(2, spy.last.started)

        // Expired: forgotten.
        h.platform.clock = Instant.parse("2026-10-11T22:00:01Z").toEpochMilliseconds()
        val later = FirmaController(h.platform, TestScope(h.dispatcher), h.dispatcher, LinkSpy().factory)
        assertIs<Screen.Start>(later.screen.value)
    }

    @Test
    fun signsAVerifiableRequestAndChecksTheBinding() = runTest {
        val h = Harness(this)
        h.pairAndConnect()
        val document = CompanionDocument(mimeType = "text/plain", size = 19, sha256 = "00".repeat(32), data = field(cms, "document"))
        h.link.deliver(h.request(documents = listOf(document), verifiable = true))
        assertEquals(Step.Review, h.screen.step())
        val card = FakeCard()
        h.controller.approve()
        // The CAN and the PIN came with the request: straight to the card.
        assertEquals(Step.HoldCard(false), h.screen.step())
        assertTrue(h.controller.readingCard.value)
        h.reader.present(card)
        assertEquals(1, h.link.sentOf<SignCertificate>().size)
        // Still on while the card is in use: turning reader mode off would drop the card.
        assertTrue(h.controller.readingCard.value)
        val check = CompanionJson.decodeFromJsonElement(Check.serializer(), cms.getValue("check"))
        h.link.deliver(ToBeSigned(h.request().requestId, 1, Algorithm.Sha256, field(cms, "toBeSigned"), check))
        assertEquals(1, card.signed.size)
        assertEquals(1, h.link.sentOf<SignSignature>().single().seq)
        h.link.deliver(SignDone(h.request().requestId))
        assertEquals(Step.Result(Outcome.Signed), h.screen.step())
        assertFalse(h.controller.readingCard.value)
        assertEquals(
            listOf(Stage.Reviewing, Stage.Card, Stage.Reading, Stage.Signing),
            h.link.sentOf<SignProgress>().map { it.stage }.distinct(),
        )
        assertTrue(card.closed)
        assertTrue((h.controller.screen.value as Screen.Signing).connected)
    }

    @Test
    fun refusesWhatDoesNotMatchTheReviewedDocument() = runTest {
        val h = Harness(this)
        h.pairAndConnect()
        val document = CompanionDocument(mimeType = "text/plain", size = 5, sha256 = "00".repeat(32), data = "b3Ryb3M=")
        h.link.deliver(h.request(documents = listOf(document), verifiable = true))
        val card = FakeCard()
        h.approveWith(card)
        h.link.deliver(ToBeSigned(h.request().requestId, 1, Algorithm.Sha256, field(cms, "toBeSigned"), Check.Cms(0)))
        assertEquals(Step.Result(Outcome.Failed(ErrorCode.BindingMismatch)), h.screen.step())
        assertEquals(ErrorCode.BindingMismatch, h.link.sentOf<SignError>().single().code)
        assertTrue(card.signed.isEmpty())
        // A verifiable request without a check is refused too.
        h.controller.dismissResult()
        h.link.deliver(h.request(id = "2f1c3b9e-2d4a-4f8b-9c1d-5e7a2b3c4d5e", documents = listOf(document), verifiable = true))
        h.approveWith(FakeCard())
        h.link.deliver(ToBeSigned("2f1c3b9e-2d4a-4f8b-9c1d-5e7a2b3c4d5e", 1, Algorithm.Sha256, "AAAA"))
        assertEquals(Step.Result(Outcome.Failed(ErrorCode.BindingMismatch)), h.screen.step())
    }

    @Test
    fun waitsForTheCardAgainWhenItMovesAndChecksItIsTheSameOne() = runTest {
        val h = Harness(this)
        h.pairAndConnect()
        h.link.deliver(h.request())
        var lose = true
        val card = FakeCard(onSign = { _, _ -> if (lose) CardException.Lost().also { lose = false } else null })
        h.approveWith(card)
        h.link.deliver(ToBeSigned(h.request().requestId, 1, Algorithm.Sha256, "AQID"))
        assertEquals(Step.HoldCard(moved = true), h.screen.step())
        h.reader.present(card)
        assertEquals(1, h.link.sentOf<SignSignature>().size)
        assertEquals(1, h.link.sentOf<SignCertificate>().size)

        // Lost again, and another DNIe comes: wrong card.
        lose = true
        h.link.deliver(ToBeSigned(h.request().requestId, 2, Algorithm.Sha256, "AQID"))
        h.reader.present(FakeCard(certificate = byteArrayOf(9, 9)))
        assertEquals(Step.Result(Outcome.Failed(ErrorCode.WrongCard)), h.screen.step())
        assertEquals(ErrorCode.WrongCard, h.link.sentOf<SignError>().single().code)
    }

    @Test
    fun asksTheDesktopForANewPinWhenItIsWrongAndStopsWhenBlocked() = runTest {
        val h = Harness(this)
        h.pairAndConnect()
        val request = h.request()
        h.link.deliver(request)
        val card = PinCard(right = "correcto")
        h.approveWith(card.card)
        h.link.deliver(ToBeSigned(request.requestId, 1, Algorithm.Sha256, "AQID"))
        assertEquals(Step.WaitForComputer(Need.Pin, refused = true, triesLeft = 2), h.screen.step())
        assertEquals(listOf(SignNeed(request.requestId, Need.Pin, refused = true, triesLeft = 2)), h.link.sentOf<SignNeed>())
        assertFalse(h.controller.readingCard.value)
        h.unlock(request.requestId, pin = "correcto")
        assertEquals(Step.HoldCard(false), h.screen.step())
        h.reader.present(card.card)
        assertEquals(listOf("secreto1", "correcto"), card.tried)
        assertEquals(1, h.link.sentOf<SignSignature>().size)
        h.link.deliver(SignDone(request.requestId))

        h.controller.dismissResult()
        h.link.deliver(h.request(id = "3f1c3b9e-2d4a-4f8b-9c1d-5e7a2b3c4d5e", pin = "otro1234"))
        h.approveWith(FakeCard(onSign = { _, _ -> CardException.PinBlocked() }))
        h.link.deliver(ToBeSigned("3f1c3b9e-2d4a-4f8b-9c1d-5e7a2b3c4d5e", 1, Algorithm.Sha256, "AQID"))
        assertEquals(Step.Result(Outcome.Failed(ErrorCode.PinBlocked)), h.screen.step())
        assertEquals(ErrorCode.PinBlocked, h.link.sentOf<SignError>().last().code)
    }

    @Test
    fun asksTheDesktopForANewCanWhenItDoesNotMatchAndNeverTriesItAgain() = runTest {
        val h = Harness(this)
        h.pairAndConnect()
        val tried = ArrayList<String>()
        val card = FakeCard(onOpen = { can -> tried += can; if (can != "654321") CardException.WrongCan() else null })
        val request = h.request(can = "000000")
        h.link.deliver(request)
        h.approveWith(card)
        assertEquals(Step.WaitForComputer(Need.Can, refused = true, triesLeft = null), h.screen.step())
        assertEquals(listOf(SignNeed(request.requestId, Need.Can, refused = true)), h.link.sentOf<SignNeed>())
        // A malformed or refused CAN isn't tried: the phone asks again for the refused one.
        h.unlock(request.requestId, can = "12345")
        h.unlock(request.requestId, can = "000000")
        assertEquals(2, h.link.sentOf<SignNeed>().size)
        h.unlock(request.requestId, can = "654321")
        h.reader.present(card)
        assertEquals(listOf("000000", "654321"), tried)
        assertEquals(1, h.link.sentOf<SignCertificate>().size)
        h.link.deliver(SignDone(request.requestId))
        // Only the pairing is stored.
        assertEquals(setOf(FirmaController.KEY_PAIRING, FirmaController.KEY_PAIRED_AT, FirmaController.KEY_EXPIRES), h.platform.store.values.keys)

        // The desktop sends the refused CAN again: not tried, the phone asks before the card.
        h.controller.dismissResult()
        val next = h.request(id = "df1c3b9e-2d4a-4f8b-9c1d-5e7a2b3c4d5e", can = "000000")
        h.link.deliver(next)
        h.controller.approve()
        assertEquals(Step.WaitForComputer(Need.Can, refused = true, triesLeft = null), h.screen.step())
        assertEquals(listOf("000000", "654321"), tried)
    }

    @Test
    fun usesTheRequestPinForThatRequestOnlyWithoutKeepingIt() = runTest {
        val h = Harness(this)
        h.pairAndConnect()
        val card = PinCard(right = "Desk1234")
        h.link.deliver(h.request(pin = "Desk1234"))
        h.controller.approve()
        assertEquals(Step.HoldCard(false), h.screen.step())
        h.reader.present(card.card)
        h.link.deliver(ToBeSigned(h.request().requestId, 1, Algorithm.Sha256, "AQID"))
        assertEquals(listOf("Desk1234"), card.tried)
        assertEquals(1, h.link.sentOf<SignSignature>().size)
        assertTrue(h.link.sentOf<SignNeed>().isEmpty())
        assertFalse(h.screen.toString().contains("Desk1234"))
        h.link.deliver(SignDone(h.request().requestId))
        h.controller.dismissResult()
        assertEquals(setOf(FirmaController.KEY_PAIRING, FirmaController.KEY_PAIRED_AT, FirmaController.KEY_EXPIRES), h.platform.store.values.keys)

        // A request without a PIN (sent again to a restarted phone): the phone asks the desktop.
        val bare = h.request(id = "1a1c3b9e-2d4a-4f8b-9c1d-5e7a2b3c4d5e", pin = null)
        h.link.deliver(bare)
        h.controller.approve()
        assertEquals(Step.WaitForComputer(Need.Pin, refused = false, triesLeft = null), h.screen.step())
        assertEquals(SignNeed(bare.requestId, Need.Pin, refused = false), h.link.sentOf<SignNeed>().last())
        // Sent again after a reconnect while it waits.
        h.link.drop()
        h.link.sent.clear()
        h.link.connect()
        assertEquals(listOf(SignNeed(bare.requestId, Need.Pin, refused = false)), h.link.sentOf<SignNeed>())
        h.controller.cancel()
        h.controller.dismissResult()

        // Reading the certificate needs no PIN: the request's isn't used.
        val reader = PinCard(right = "Desk1234")
        h.link.deliver(h.request(id = "1b1c3b9e-2d4a-4f8b-9c1d-5e7a2b3c4d5e", purpose = Purpose.Certificate, pin = "Desk1234"))
        h.controller.approve()
        h.reader.present(reader.card)
        assertEquals(1, h.link.sentOf<SignCertificate>().size)
        assertTrue(reader.tried.isEmpty())
    }

    @Test
    fun triesAWrongPinOnceAndNeverAgain() = runTest {
        val h = Harness(this)
        h.pairAndConnect()
        val card = PinCard(right = "Right123")
        val request = h.request(pin = "Wrong123")
        h.link.deliver(request)
        h.approveWith(card.card)
        h.link.deliver(ToBeSigned(request.requestId, 1, Algorithm.Sha256, "AQID"))
        assertEquals(Step.WaitForComputer(Need.Pin, refused = true, triesLeft = 2), h.screen.step())
        assertEquals(listOf("Wrong123"), card.tried)

        // After a reconnect the desktop sends its request again: the phone repeats its need.
        h.link.drop()
        h.link.sent.clear()
        h.link.connect()
        h.link.deliver(request)
        h.link.deliver(ToBeSigned(request.requestId, 1, Algorithm.Sha256, "AQID"))
        assertEquals(listOf("Wrong123"), card.tried)
        assertTrue(h.link.sentOf<SignNeed>().isNotEmpty())
        assertTrue(h.link.sentOf<SignNeed>().all { it == SignNeed(request.requestId, Need.Pin, refused = true, triesLeft = 2) })

        // The same wrong PIN again (a stale one on the desktop): not tried.
        h.link.sent.clear()
        h.unlock(request.requestId, pin = "Wrong123")
        assertEquals(listOf(SignNeed(request.requestId, Need.Pin, refused = true, triesLeft = 2)), h.link.sentOf<SignNeed>())
        h.unlock(request.requestId, pin = "Right123")
        assertEquals(Step.HoldCard(false), h.screen.step())
        h.reader.present(card.card)
        assertEquals(listOf("Wrong123", "Right123"), card.tried)
        assertEquals(1, card.card.signed.size)
        h.link.deliver(SignDone(request.requestId))
        h.controller.dismissResult()

        // A later request with the refused PIN: asked for before the card, never tried.
        val later = h.request(id = "2a1c3b9e-2d4a-4f8b-9c1d-5e7a2b3c4d5e", pin = "Wrong123")
        h.link.deliver(later)
        h.controller.approve()
        assertEquals(Step.WaitForComputer(Need.Pin, refused = true, triesLeft = null), h.screen.step())
        assertEquals(listOf("Wrong123", "Right123"), card.tried)
    }

    @Test
    fun ignoresAnUnlockItDidNotAskForAndGivesUpWaiting() = runTest {
        val h = Harness(this)
        h.pairAndConnect()
        val card = PinCard(right = "Right123")
        val request = h.request(pin = "Wrong123")
        h.link.deliver(request)
        h.approveWith(card.card)
        // Not waiting: dropped, not kept for later.
        h.unlock(request.requestId, pin = "Right123")
        h.link.deliver(ToBeSigned(request.requestId, 1, Algorithm.Sha256, "AQID"))
        assertEquals(Step.WaitForComputer(Need.Pin, refused = true, triesLeft = 2), h.screen.step())
        advanceTimeBy(FirmaController.UNLOCK_WAIT_MS + 1)
        runCurrent()
        assertEquals(Step.Result(Outcome.Failed(ErrorCode.Timeout)), h.screen.step())
        assertEquals(listOf("Wrong123"), card.tried)
    }

    @Test
    fun endsWhenTheCardIsBlocked() = runTest {
        val h = Harness(this)
        h.pairAndConnect()
        // Two wrong PINs elsewhere (another reader): the phone can't know.
        val card = PinCard(right = "Right123", tries = 1)
        val request = h.request(pin = "Wrong123")
        h.link.deliver(request)
        h.approveWith(card.card)
        h.link.deliver(ToBeSigned(request.requestId, 1, Algorithm.Sha256, "AQID"))
        assertEquals(Step.Result(Outcome.Failed(ErrorCode.PinBlocked)), h.screen.step())
        assertEquals(ErrorCode.PinBlocked, h.link.sentOf<SignError>().single().code)
        assertEquals(listOf("Wrong123"), card.tried)
        assertTrue(h.link.sentOf<SignNeed>().isEmpty())
    }

    @Test
    fun refusesARequestWithAMalformedPin() = runTest {
        val h = Harness(this)
        h.pairAndConnect()
        for (pin in listOf("1234567", "12345678901234567", "")) {
            h.link.deliver(h.request(pin = pin))
            assertEquals(ErrorCode.Protocol, h.link.sentOf<SignError>().last().code, pin)
            assertIs<Screen.Home>(h.screen)
        }
    }

    @Test
    fun refusesARequestWithAMalformedOrMissingCan() = runTest {
        val h = Harness(this)
        h.pairAndConnect()
        for (can in listOf("12345", "1234567", "12345a", "")) {
            h.link.deliver(h.request(can = can))
            assertEquals(ErrorCode.Protocol, h.link.sentOf<SignError>().last().code, can)
            assertIs<Screen.Home>(h.screen)
        }
        val vectors = Json.parseToJsonElement(VECTORS_JSON).jsonObject.getValue("login").jsonObject
        val noCan = JsonObject(vectors.getValue("request").jsonObject - "can")
        assertFails { CompanionJson.decodeFromString<DesktopToPhone>(noCan.toString()) }
    }

    @Test
    fun answersBusyDuplicatesAndReconnects() = runTest {
        val h = Harness(this)
        h.pairAndConnect()
        val request = h.request()
        h.link.deliver(request)
        h.link.deliver(h.request(id = "4f1c3b9e-2d4a-4f8b-9c1d-5e7a2b3c4d5e"))
        assertEquals(ErrorCode.Busy, h.link.sentOf<SignError>().single().code)
        val card = FakeCard()
        h.approveWith(card)
        h.link.deliver(ToBeSigned(request.requestId, 1, Algorithm.Sha256, "AQID"))
        assertEquals(1, card.signed.size)

        // The connection drops and comes back; the desktop sends everything again.
        h.link.drop()
        h.link.sent.clear()
        h.link.connect()
        h.link.deliver(request)
        h.link.deliver(ToBeSigned(request.requestId, 1, Algorithm.Sha256, "AQID"))
        assertEquals(1, card.signed.size, "never signs the same blob twice")
        assertTrue(h.link.sentOf<SignCertificate>().isNotEmpty())
        assertTrue(h.link.sentOf<SignSignature>().all { it.seq == 1 })
        assertTrue(h.link.sentOf<SignSignature>().isNotEmpty())
    }

    @Test
    fun takesTheNextRequestRightAfterDone() = runTest {
        val h = Harness(this)
        h.pairAndConnect()
        val first = h.request()
        h.link.deliver(first)
        h.approveWith(FakeCard())
        h.link.deliver(ToBeSigned(first.requestId, 1, Algorithm.Sha256, "AQID"))
        // A batch: `sign.done` and the next request arrive together, before the runner wakes up.
        val second = h.request(id = "bf1c3b9e-2d4a-4f8b-9c1d-5e7a2b3c4d5e")
        h.link.listener.onMessage(SignDone(first.requestId))
        h.link.listener.onMessage(second)
        assertTrue(h.link.sentOf<SignError>().none { it.code == ErrorCode.Busy })
        assertEquals(Step.Review, h.screen.step())
        assertEquals(second.requestId, (h.screen as Screen.Signing).request.requestId)
    }

    @Test
    fun cancelsDeclinesAndExpires() = runTest {
        val h = Harness(this)
        h.pairAndConnect()
        h.link.deliver(h.request())
        h.controller.decline()
        assertEquals(Step.Result(Outcome.Declined), h.screen.step())
        assertEquals(ErrorCode.Rejected, h.link.sentOf<SignError>().last().code)

        h.controller.dismissResult()
        h.link.deliver(h.request(id = "5f1c3b9e-2d4a-4f8b-9c1d-5e7a2b3c4d5e"))
        h.controller.approve()
        h.link.deliver(SignCancel("5f1c3b9e-2d4a-4f8b-9c1d-5e7a2b3c4d5e", CancelReason.Cancelled))
        assertEquals(Step.Result(Outcome.CancelledByDesktop), h.screen.step())

        h.controller.dismissResult()
        h.link.deliver(h.request(id = "7f1c3b9e-2d4a-4f8b-9c1d-5e7a2b3c4d5e"))
        h.controller.approve()
        h.controller.cancel()
        assertEquals(Step.Result(Outcome.Cancelled), h.screen.step())
        assertEquals(ErrorCode.Cancelled, h.link.sentOf<SignError>().last().code)
        assertEquals(0, h.reader.waiting, "no longer reading")

        h.controller.dismissResult()
        h.link.deliver(h.request(id = "8f1c3b9e-2d4a-4f8b-9c1d-5e7a2b3c4d5e", expiresIn = -1))
        assertEquals(ErrorCode.Timeout, h.link.sentOf<SignError>().last().code)
        assertIs<Screen.Home>(h.screen)

        h.link.deliver(h.request(id = "9f1c3b9e-2d4a-4f8b-9c1d-5e7a2b3c4d5e", expiresIn = 1_000))
        advanceTimeBy(2_000)
        runCurrent()
        assertEquals(Step.Result(Outcome.Expired), h.screen.step())
    }

    @Test
    fun saysWhenThePhoneHasNoNfc() = runTest {
        val h = Harness(this)
        h.pairAndConnect()
        h.reader.nfc.value = es.spainassist.firma.card.NfcAvailability.Missing
        h.link.deliver(h.request())
        h.controller.approve()
        assertEquals(Step.Result(Outcome.Failed(ErrorCode.NfcUnavailable)), h.screen.step())
        assertEquals(ErrorCode.NfcUnavailable, h.link.sentOf<SignError>().single().code)
    }

    @Test
    fun endsThePairingFromEitherSide() = runTest {
        val h = Harness(this)
        h.pairAndConnect()
        h.controller.unpair()
        assertTrue(h.link.unpaired)
        assertIs<Screen.Start>(h.screen)
        assertNull(h.platform.store.get(FirmaController.KEY_PAIRING))

        h.pairAndConnect()
        h.link.listener.onStatus(LinkStatus.Ended(LinkStatus.Ended.Reason.DesktopUnpaired))
        assertEquals(StartNotice.DesktopUnpaired, (h.screen as Screen.Start).notice)
        assertTrue(PhoneBye.toString().isNotEmpty())
    }

    private fun Harness.pairUntil(expiresIn: Long) {
        controller.onLink(testLink())
        controller.confirmPairing()
        link.connect(expiresAt = Instant.fromEpochMilliseconds(platform.clock + expiresIn).toString())
    }

    @Test
    fun keepsThePairingWhileTheRelayHasLostTheRoom() = runTest {
        val h = Harness(this)
        h.pairUntil(FirmaController.PAIRING_MAX_MS)
        val request = h.request()
        h.link.deliver(request)
        // The relay restarted: it doesn't know the room until the desktop reconnects.
        h.link.roomMissing()
        assertEquals(Step.Review, h.screen.step())
        h.platform.clock += 60 * 60_000L
        h.link.roomMissing()
        assertFalse(h.link.closed)
        assertTrue(h.platform.store.values.containsKey(FirmaController.KEY_PAIRING))
        assertTrue(h.platform.store.values.containsKey(FirmaController.KEY_MISSING_SINCE))

        // The desktop is back: same pairing, same link, and the request goes on.
        h.link.connect()
        assertEquals(1, h.spy.links.size)
        assertNull(h.platform.store.get(FirmaController.KEY_MISSING_SINCE))
        assertEquals(Step.Review, h.screen.step())
        h.link.deliver(SignCancel(request.requestId, CancelReason.Cancelled))
        h.controller.dismissResult()

        // On the home screen it reads as "your computer isn't connected".
        h.link.roomMissing()
        assertEquals(LinkStatus.RoomMissing, (h.screen as Screen.Home).link)
        // A new process keeps waiting (and remembers since when).
        val spy = LinkSpy()
        val again = FirmaController(h.platform, TestScope(h.dispatcher), h.dispatcher, spy.factory)
        assertIs<Screen.Home>(again.screen.value)
        assertEquals(1, spy.last.started)
        spy.last.roomMissing()
        assertIs<Screen.Home>(again.screen.value)
        spy.last.connect()
        assertIs<LinkStatus.Connected>((again.screen.value as Screen.Home).link)
    }

    @Test
    fun givesUpOnAMissingRoomOnceThePairingExpires() = runTest {
        val h = Harness(this)
        h.pairUntil(60 * 60_000L)
        h.link.roomMissing()
        assertIs<Screen.Home>(h.screen)
        h.platform.clock += 61 * 60_000L
        h.link.roomMissing()
        assertTrue(h.link.closed)
        assertEquals(StartNotice.PairingExpired, (h.screen as Screen.Start).notice)
        assertNull(h.platform.store.get(FirmaController.KEY_PAIRING))
        assertNull(h.platform.store.get(FirmaController.KEY_MISSING_SINCE))
    }

    @Test
    fun givesUpOnARoomMissingForADay() = runTest {
        val h = Harness(this)
        h.pairUntil(FirmaController.PAIRING_MAX_MS)
        h.link.roomMissing()
        // The relay had the room again (the desktop was there for a while): the wait starts over.
        h.platform.clock += 20 * 60 * 60_000L
        h.link.listener.onStatus(LinkStatus.DesktopAway)
        h.link.roomMissing()
        h.platform.clock += 20 * 60 * 60_000L
        h.link.roomMissing()
        assertIs<Screen.Home>(h.screen)
        h.platform.clock += 4 * 60 * 60_000L + 1
        h.link.roomMissing()
        assertTrue(h.link.closed)
        assertEquals(StartNotice.PairingEnded, (h.screen as Screen.Start).notice)
        assertNull(h.platform.store.get(FirmaController.KEY_PAIRING))
    }
}
