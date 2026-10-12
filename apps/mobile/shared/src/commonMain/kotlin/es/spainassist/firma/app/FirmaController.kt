package es.spainassist.firma.app

import es.spainassist.firma.card.Card
import es.spainassist.firma.card.CardException
import es.spainassist.firma.card.DnieSession
import es.spainassist.firma.card.NfcAvailability
import es.spainassist.firma.channel.Base64Std
import es.spainassist.firma.channel.ChannelException
import es.spainassist.firma.channel.PairingLink
import es.spainassist.firma.protocol.DesktopBye
import es.spainassist.firma.protocol.DesktopToPhone
import es.spainassist.firma.protocol.ErrorCode
import es.spainassist.firma.protocol.Hello
import es.spainassist.firma.protocol.PhoneToDesktop
import es.spainassist.firma.protocol.Purpose
import es.spainassist.firma.protocol.SignCancel
import es.spainassist.firma.protocol.SignCertificate
import es.spainassist.firma.protocol.SignDone
import es.spainassist.firma.protocol.SignError
import es.spainassist.firma.protocol.SignProgress
import es.spainassist.firma.protocol.SignRequest
import es.spainassist.firma.protocol.SignSignature
import es.spainassist.firma.protocol.SignWrongPin
import es.spainassist.firma.protocol.Stage
import es.spainassist.firma.protocol.ToBeSigned
import es.spainassist.firma.relay.LinkListener
import es.spainassist.firma.relay.LinkStatus
import es.spainassist.firma.relay.PhoneLink
import es.spainassist.firma.sign.Binding
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CoroutineDispatcher
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.IO
import kotlinx.coroutines.Job
import kotlinx.coroutines.channels.Channel
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import kotlinx.coroutines.withTimeoutOrNull
import kotlin.time.ExperimentalTime
import kotlin.time.Instant

/** The link to the desktop, as the controller uses it ([PhoneLink]; fakes in tests). */
interface CompanionLink {
    val connected: Boolean

    fun start()

    fun close()

    fun unpair()

    fun send(message: PhoneToDesktop): Boolean
}

typealias LinkFactory = (pairing: PairingLink, hello: Hello, listener: LinkListener) -> CompanionLink

/**
 * The phone app's state machine. Everything runs on [scope], which must be serial (the main
 * thread on Android); card I/O runs on IO threads.
 *
 * Pairing: a scanned or opened link is confirmed by the user, stored encrypted, and restored on
 * the next launch until it expires. Signing: review → CAN (sent by the desktop from Mis datos, or
 * typed once; stored when the card accepts it) → PIN (sent by the desktop from Mis datos for this
 * request only, or typed and cached for 60 minutes in memory) → hold the card → read the
 * certificate → sign each `sign.toBeSigned` while the card stays near, checking each one against
 * the reviewed documents when the request is verifiable. The card may move (we wait for it again
 * and check it's the same one), the PIN or CAN may be wrong (asked again; a cached or desktop PIN
 * is never retried, and a refused desktop PIN is reported with `sign.wrongPin`), the desktop may
 * cancel or reconnect (everything it may have missed is sent again; duplicates are answered from
 * cache, never signed twice).
 */
@OptIn(ExperimentalTime::class)
class FirmaController(
    private val platform: Platform,
    private val scope: CoroutineScope,
    /** Where blocking card I/O runs (tests run it inline). */
    private val io: CoroutineDispatcher = Dispatchers.IO,
    private val linkFactory: LinkFactory = { pairing, hello, listener ->
        val link = PhoneLink(pairing, hello, { events ->
            platform.relay(pairing.relayUrl, pairing.roomId, events)
        }, listener, platform::log)
        object : CompanionLink {
            override val connected get() = link.connected

            override fun start() = link.start()

            override fun close() = link.close()

            override fun unpair() = link.unpair()

            override fun send(message: PhoneToDesktop) = link.send(message)
        }
    },
) {
    private val store = platform.store
    private val cardReader = platform.cardReader
    private val _screen = MutableStateFlow<Screen>(Screen.Start(cardReader.nfc.value))
    val screen: StateFlow<Screen> = _screen.asStateFlow()

    private var link: CompanionLink? = null
    private var linkStatus: LinkStatus = LinkStatus.Connecting
    private var proposed: PairingLink? = null
    private var notice: StartNotice? = null
    private var pin: String? = null
    private var pinAt = 0L
    private var active: Active? = null

    /** A CAN from the desktop that the card refused: not tried again until Mis datos changes. */
    private var rejectedCan: String? = null

    /**
     * The tries the card said it has left after a wrong PIN, until it accepts one. While it's
     * known, a PIN from the desktop isn't used: the user types it. So a saved PIN costs at most
     * one try, even if the desktop never hears that it was wrong (DECISIONS D18).
     */
    private var pinTriesLeft: Int? = null

    /**
     * Whether the reader should be on: from asking for the card until the request is done with
     * it (the UI keeps NFC reader mode on only then).
     */
    private val _readingCard = MutableStateFlow(false)
    val readingCard: StateFlow<Boolean> = _readingCard.asStateFlow()

    init {
        scope.launch { cardReader.nfc.collect { render() } }
        scope.launch { restorePairing() }
    }

    // ------------------------------------------------------------------------------------------
    // Pairing
    // ------------------------------------------------------------------------------------------

    /** A link from a QR code or an App Link / `sa-firma://` intent. */
    fun onLink(text: String) = scope.launch {
        val parsed = try {
            PairingLink.parse(text, platform.allowInsecureRelay)
        } catch (e: ChannelException) {
            if (link == null) notice = StartNotice.BadLink
            render()
            return@launch
        }
        if (stored()?.let { it == parsed } == true && link != null) {
            // The same QR again: just make sure we're connected.
            link?.start()
            return@launch
        }
        proposed = parsed
        render()
    }

    fun confirmPairing() = scope.launch {
        val next = proposed ?: return@launch
        proposed = null
        if (link != null) endPairing(sendBye = true)
        store.put(KEY_PAIRING, next.encode())
        store.put(KEY_PAIRED_AT, platform.now().toString())
        store.remove(KEY_EXPIRES)
        notice = null
        connect(next)
    }

    fun cancelPairing() = scope.launch {
        proposed = null
        render()
    }

    fun unpair() = scope.launch {
        endPairing(sendBye = true)
        render()
    }

    private fun stored(): PairingLink? {
        val payload = store.get(KEY_PAIRING) ?: return null
        val expired = store.get(KEY_EXPIRES)?.toLongOrNull()?.let { platform.now() > it }
            ?: store.get(KEY_PAIRED_AT)?.toLongOrNull()?.let { platform.now() > it + PAIRING_MAX_MS }
            ?: true
        if (expired) {
            clearPairing()
            return null
        }
        return runCatching { PairingLink.decode(payload, platform.allowInsecureRelay) }.getOrElse {
            clearPairing()
            null
        }
    }

    private fun restorePairing() {
        stored()?.let { connect(it) }
        render()
    }

    private fun connect(pairing: PairingLink) {
        val hello = Hello(app = platform.appVersion, platform = platform.platformName, device = platform.deviceName)
        lateinit var created: CompanionLink
        created = linkFactory(pairing, hello, object : LinkListener {
            override fun onStatus(status: LinkStatus) {
                if (link === created) onLinkStatus(status)
            }

            override fun onMessage(message: DesktopToPhone) {
                if (link === created) onDesktopMessage(message)
            }

            override fun onSession() {
                if (link === created) active?.let(::resend)
            }
        })
        link = created
        linkStatus = LinkStatus.Connecting
        created.start()
        render()
    }

    private fun onLinkStatus(status: LinkStatus) {
        linkStatus = status
        if (status is LinkStatus.Connected) {
            parseInstant(status.welcome.expiresAt)?.let { store.put(KEY_EXPIRES, it.toString()) }
        }
        if (status is LinkStatus.Ended) {
            notice = when (status.reason) {
                LinkStatus.Ended.Reason.Expired -> StartNotice.PairingExpired
                LinkStatus.Ended.Reason.Replaced -> StartNotice.Replaced
                LinkStatus.Ended.Reason.DesktopUnpaired -> StartNotice.DesktopUnpaired
                LinkStatus.Ended.Reason.NotFound -> StartNotice.PairingEnded
                LinkStatus.Ended.Reason.Unpaired -> null
            }
            endPairing(sendBye = false)
        }
        render()
    }

    private fun endPairing(sendBye: Boolean) {
        val current = link
        link = null
        if (sendBye) current?.unpair() else current?.close()
        clearPairing()
        pin = null
        active?.let { stopActive(it, Outcome.Cancelled, sendError = null) }
        active = null
        linkStatus = LinkStatus.Connecting
    }

    private fun clearPairing() {
        store.remove(KEY_PAIRING)
        store.remove(KEY_PAIRED_AT)
        store.remove(KEY_EXPIRES)
    }

    // ------------------------------------------------------------------------------------------
    // Settings
    // ------------------------------------------------------------------------------------------

    fun forgetPin() = scope.launch {
        pin = null
        render()
    }

    fun forgetCan() = scope.launch {
        store.remove(KEY_CAN)
        render()
    }

    fun openNfcSettings() = platform.openNfcSettings()

    // ------------------------------------------------------------------------------------------
    // Requests
    // ------------------------------------------------------------------------------------------

    /** [request] has no PIN: [desktopPin] holds it until the card refuses it or the request ends. */
    private class Active(val request: SignRequest, val review: Review, var desktopPin: String?) {
        var step: Step = Step.Review
        var job: Job? = null
        val actions = Channel<Action>(Channel.UNLIMITED)
        val inbox = Channel<DesktopToPhone>(Channel.UNLIMITED)
        var progress: Stage = Stage.Reviewing
        var certificates: List<String>? = null

        /** The desktop's CAN, until the card accepts it (then it is the stored one). */
        var desktopCan: String? = request.can

        /** The card refused [desktopPin]: told to the desktop (again after a reconnect). */
        var pinRefused = false
        val signatures = LinkedHashMap<Int, String>()
        var error: SignError? = null

        /** The desktop said `sign.done`: its next request may arrive before the runner sees it. */
        var done = false
        val finished get() = step is Step.Result
    }

    private enum class Prepared { Ready, Declined, NoNfc }

    private sealed interface Action {
        data object Approve : Action

        data object Decline : Action

        data object Cancel : Action

        data class Can(val value: String) : Action

        data class Pin(val value: String) : Action
    }

    fun approve() = act(Action.Approve)

    fun decline() = act(Action.Decline)

    /** Stops a request half-way (after approving). */
    fun cancel() = act(Action.Cancel)

    fun submitCan(can: String) = act(Action.Can(can.filter(Char::isDigit)))

    fun submitPin(pin: String) = act(Action.Pin(pin))

    /** Leaves a finished request's result. */
    fun dismissResult() = scope.launch {
        if (active?.finished == true) active = null
        render()
    }

    private fun act(action: Action) = scope.launch {
        val current = active ?: return@launch
        if (current.finished) return@launch
        if (action == Action.Cancel) {
            if (current.request.purpose == Purpose.Login) return@launch
            stopActive(current, Outcome.Cancelled, ErrorCode.Cancelled)
            return@launch
        }
        current.actions.trySend(action)
    }

    private fun onDesktopMessage(message: DesktopToPhone) {
        when (message) {
            is SignRequest -> onRequest(message)
            is ToBeSigned, is SignDone -> {
                val current = active ?: return
                val id = if (message is ToBeSigned) message.requestId else (message as SignDone).requestId
                if (current.request.requestId != id || current.finished) return
                if (message is SignDone) current.done = true
                current.inbox.trySend(message)
            }
            is SignCancel -> {
                val current = active ?: return
                if (current.request.requestId != message.requestId || current.finished) return
                stopActive(current, Outcome.CancelledByDesktop, sendError = null)
            }
            DesktopBye -> Unit // PhoneLink ends the pairing itself.
        }
    }

    private fun onRequest(request: SignRequest) {
        val current = active
        if (current != null && current.request.requestId == request.requestId) {
            resend(current)
            return
        }
        if (current != null && !current.finished) {
            if (!current.done) {
                send(SignError(request.requestId, ErrorCode.Busy))
                return
            }
            // Signed already (batches: the next request follows `sign.done` at once).
            val outcome = if (current.request.purpose == Purpose.Certificate) Outcome.CertificateShared else Outcome.Signed
            stopActive(current, outcome, sendError = null)
        }
        val expiresAt = parseInstant(request.expiresAt)
        if (expiresAt == null || expiresAt <= platform.now()) {
            send(SignError(request.requestId, ErrorCode.Timeout))
            return
        }
        if (request.purpose == Purpose.Login && (request.documents.isNotEmpty() || request.verifiable || request.format.isNotEmpty())) {
            send(SignError(request.requestId, ErrorCode.Protocol))
            return
        }
        val documents = request.documents.map { document ->
            val bytes = document.data?.let { runCatching { Base64Std.decode(it) }.getOrNull() }
            ReviewDocument(document.name, document.mimeType, document.size, document.sha256, bytes)
        }
        if (request.documents.any { it.data != null } && documents.any { it.data == null && it.size > 0 }) {
            send(SignError(request.requestId, ErrorCode.Protocol, "bad document"))
            return
        }
        if (request.signatures != null && request.signatures < 1) {
            send(SignError(request.requestId, ErrorCode.Protocol, "bad signature count"))
            return
        }
        if (request.can != null && !CAN_PATTERN.matches(request.can)) {
            send(SignError(request.requestId, ErrorCode.Protocol, "bad CAN"))
            return
        }
        if (request.pin != null && request.pin.length !in PIN_LENGTH) {
            send(SignError(request.requestId, ErrorCode.Protocol, "bad PIN"))
            return
        }
        val review = Review(
            requestId = request.requestId,
            purpose = request.purpose,
            host = hostOf(request.origin),
            description = request.description,
            format = request.format,
            documents = documents,
            verifiable = request.verifiable,
            signatures = request.signatures,
        )
        // Reading the certificate needs no PIN; after a wrong PIN the user types it.
        val desktopPin = request.pin?.takeIf { request.purpose != Purpose.Certificate && pinTriesLeft == null }
        val next = Active(request.copy(pin = null), review, desktopPin)
        if (next.desktopCan == rejectedCan) next.desktopCan = null
        active = next
        next.job = scope.launch {
            try {
                run(next, expiresAt)
            } catch (e: CancellationException) {
                throw e
            } catch (e: Exception) {
                // The message may quote request data: log only the class name.
                platform.log("request failed: ${e::class.simpleName}")
                finish(next, Outcome.Failed(ErrorCode.Internal), ErrorCode.Internal)
            }
        }
        render()
    }

    private suspend fun run(r: Active, expiresAt: Long) {
        progress(r, Stage.Reviewing)
        setStep(r, Step.Review)
        val prepared = withTimeoutOrNull(expiresAt - platform.now()) {
            if (r.actions.receive() != Action.Approve) return@withTimeoutOrNull Prepared.Declined
            if (cardReader.nfc.value == NfcAvailability.Missing) return@withTimeoutOrNull Prepared.NoNfc
            ensureCan(r, wrong = false)
            if (r.request.purpose != Purpose.Certificate) ensurePin(r, wrong = false, retriesLeft = pinTriesLeft)
            Prepared.Ready
        }
        when (prepared) {
            null -> return finish(r, Outcome.Expired, ErrorCode.Timeout)
            Prepared.Declined -> return finish(r, Outcome.Declined, ErrorCode.Rejected)
            Prepared.NoNfc -> return finish(r, Outcome.Failed(ErrorCode.NfcUnavailable), ErrorCode.NfcUnavailable)
            Prepared.Ready -> Unit
        }
        readAndSign(r, expiresAt)
    }

    private suspend fun ensureCan(r: Active, wrong: Boolean, fromComputer: Boolean = false) {
        if (!wrong && (r.desktopCan != null || store.get(KEY_CAN) != null)) return
        setStep(r, Step.EnterCan(wrong, fromComputer))
        while (true) {
            val action = r.actions.receive()
            if (action is Action.Can && action.value.length == CAN_LENGTH) {
                store.put(KEY_CAN, action.value)
                return
            }
        }
    }

    private suspend fun ensurePin(r: Active, wrong: Boolean, retriesLeft: Int?, fromComputer: Boolean = false) {
        if (!wrong && (r.desktopPin != null || currentPin() != null)) return
        setStep(r, Step.EnterPin(wrong, retriesLeft, fromComputer))
        while (true) {
            val action = r.actions.receive()
            if (action is Action.Pin && action.value.length in PIN_LENGTH) {
                pin = action.value
                pinAt = platform.now()
                render()
                return
            }
        }
    }

    private fun currentPin(): String? {
        val cached = pin ?: return null
        if (platform.now() - pinAt > PIN_CACHE_MS) {
            pin = null
            return null
        }
        return cached
    }

    private suspend fun readAndSign(r: Active, expiresAt: Long) {
        var card: Card? = null
        var session: DnieSession? = null
        var moved = false
        var retry: ToBeSigned? = null
        try {
            while (true) {
                if (session == null) {
                    // Until the card is read the request's own deadline applies.
                    if (r.certificates == null && platform.now() > expiresAt) {
                        return finish(r, Outcome.Expired, ErrorCode.Timeout)
                    }
                    setStep(r, Step.HoldCard(moved))
                    progress(r, Stage.Card)
                    // On until the card is no longer needed: turning reader mode off drops the
                    // tag, so it can't go off as soon as the card shows up.
                    _readingCard.value = true
                    val held = if (r.certificates == null) {
                        withTimeoutOrNull(expiresAt - platform.now()) { cardReader.awaitCard() }
                            ?: return finish(r, Outcome.Expired, ErrorCode.Timeout)
                    } else {
                        withTimeoutOrNull(CARD_AGAIN_MS) { cardReader.awaitCard() }
                            ?: return finish(r, Outcome.Failed(ErrorCode.Timeout), ErrorCode.Timeout)
                    }
                    card = held
                    setStep(r, Step.Working(reading = true, signed = r.signatures.size))
                    progress(r, Stage.Reading)
                    val can = r.desktopCan ?: store.get(KEY_CAN) ?: return finish(r, Outcome.Failed(ErrorCode.Internal), ErrorCode.Internal)
                    val opened = try {
                        withContext(io) { held.open(can, r.request.purpose) { r.desktopPin ?: currentPin() ?: throw CardException.Failed("no PIN") } }
                    } catch (e: CardException) {
                        held.closeQuietly()
                        card = null
                        when (e) {
                            is CardException.Lost -> {
                                moved = true
                                continue
                            }
                            is CardException.WrongCan -> {
                                val fromComputer = r.desktopCan != null
                                if (fromComputer) rejectedCan = r.desktopCan
                                r.desktopCan = null
                                store.remove(KEY_CAN)
                                ensureCan(r, wrong = true, fromComputer = fromComputer)
                                moved = false
                                continue
                            }
                            else -> return fail(r, e)
                        }
                    }
                    r.desktopCan?.let {
                        store.put(KEY_CAN, it)
                        r.desktopCan = null
                    }
                    val certificates = opened.certificates.map { Base64Std.encode(it) }
                    val first = r.certificates
                    if (first == null) {
                        r.certificates = certificates
                        send(SignCertificate(r.request.requestId, certificates))
                    } else if (first.first() != certificates.first()) {
                        held.closeQuietly()
                        return finish(r, Outcome.Failed(ErrorCode.WrongCard), ErrorCode.WrongCard)
                    }
                    session = opened
                    moved = false
                }

                val item = retry ?: (
                    withTimeoutOrNull(NEXT_ITEM_MS) { r.inbox.receive() }
                        ?: return finish(r, Outcome.Failed(ErrorCode.Timeout), ErrorCode.Timeout)
                    )
                retry = null
                when (item) {
                    is SignDone -> return finish(
                        r,
                        if (r.request.purpose == Purpose.Certificate) Outcome.CertificateShared else Outcome.Signed,
                        sendError = null,
                    )
                    is ToBeSigned -> {
                        r.signatures[item.seq]?.let {
                            send(SignSignature(r.request.requestId, item.seq, it))
                            continue
                        }
                        if (r.request.purpose == Purpose.Certificate) {
                            return finish(r, Outcome.Failed(ErrorCode.Protocol), ErrorCode.Protocol)
                        }
                        // No more signatures than the review showed the user.
                        val limit = r.request.signatures
                        if (limit != null && r.signatures.size >= limit) {
                            return finish(r, Outcome.Failed(ErrorCode.Protocol), ErrorCode.Protocol)
                        }
                        val data = runCatching { Base64Std.decode(item.data) }.getOrNull()
                            ?: return finish(r, Outcome.Failed(ErrorCode.Protocol), ErrorCode.Protocol)
                        val login = r.request.purpose == Purpose.Login
                        val digestSize = when (item.algorithm) {
                            es.spainassist.firma.protocol.Algorithm.Sha1 -> 20
                            es.spainassist.firma.protocol.Algorithm.Sha256 -> 32
                            es.spainassist.firma.protocol.Algorithm.Sha384 -> 48
                            es.spainassist.firma.protocol.Algorithm.Sha512 -> 64
                        }
                        if (login != (item.prehashed == true) || (login && (data.size != digestSize || item.check != null))) {
                            return finish(r, Outcome.Failed(ErrorCode.Protocol), ErrorCode.Protocol)
                        }
                        if (r.request.verifiable) {
                            val check = item.check
                            val documents = r.review.documents.map { it.data }
                            if (check == null || !Binding.verify(check, item.algorithm, data, documents)) {
                                return finish(r, Outcome.Failed(ErrorCode.BindingMismatch), ErrorCode.BindingMismatch)
                            }
                        }
                        setStep(r, Step.Working(reading = false, signed = r.signatures.size))
                        progress(r, Stage.Signing)
                        val signer = session ?: continue
                        val signature = try {
                            withContext(io) { signer.sign(data, item.algorithm, item.prehashed == true) }
                        } catch (e: CardException) {
                            card?.closeQuietly()
                            card = null
                            session = null
                            retry = item
                            when (e) {
                                is CardException.Lost -> {
                                    moved = true
                                    continue
                                }
                                is CardException.WrongPin -> {
                                    // Never tried again: neither the cached PIN nor the desktop's.
                                    val fromComputer = r.desktopPin != null
                                    r.desktopPin = null
                                    pin = null
                                    pinTriesLeft = e.retriesLeft
                                    if (fromComputer) {
                                        r.pinRefused = true
                                        send(SignWrongPin(r.request.requestId))
                                    }
                                    if (e.retriesLeft <= 0) return fail(r, CardException.PinBlocked())
                                    ensurePin(r, wrong = true, retriesLeft = e.retriesLeft, fromComputer = fromComputer)
                                    continue
                                }
                                else -> return fail(r, e)
                            }
                        }
                        // The card accepted the PIN: its tries are back to the full count.
                        pinTriesLeft = null
                        val encoded = Base64Std.encode(signature)
                        r.signatures[item.seq] = encoded
                        send(SignSignature(r.request.requestId, item.seq, encoded))
                        setStep(r, Step.Working(reading = false, signed = r.signatures.size))
                    }
                    else -> Unit
                }
            }
        } finally {
            card?.closeQuietly()
            _readingCard.value = false
        }
    }

    private fun fail(r: Active, e: CardException) {
        val code = when (e) {
            is CardException.PinBlocked -> ErrorCode.PinBlocked
            is CardException.Unsupported -> ErrorCode.CardUnsupported
            is CardException.NoCertificate -> ErrorCode.NoCertificate
            is CardException.CertificateExpired -> ErrorCode.CertificateExpired
            else -> ErrorCode.Internal
        }
        if (code == ErrorCode.PinBlocked) {
            pin = null
            pinTriesLeft = 0
        }
        platform.log("card error: ${e::class.simpleName} ${e.message}")
        finish(r, Outcome.Failed(code), code)
    }

    /** Ends [r] from outside its runner (user or desktop cancel, pairing ended). */
    private fun stopActive(r: Active, outcome: Outcome, sendError: ErrorCode?) {
        r.job?.cancel()
        _readingCard.value = false
        finish(r, outcome, sendError)
    }

    private fun finish(r: Active, outcome: Outcome, sendError: ErrorCode?) {
        r.desktopPin = null
        if (r.finished) return
        if (sendError != null) {
            val error = SignError(r.request.requestId, sendError)
            r.error = error
            send(error)
        }
        setStep(r, Step.Result(outcome))
        if (active === r) {
            scope.launch {
                delay(RESULT_MS)
                if (active === r) {
                    active = null
                    render()
                }
            }
        }
    }

    /** After a reconnect: everything the desktop may have missed for this request. */
    private fun resend(r: Active) {
        val id = r.request.requestId
        if (r.pinRefused) send(SignWrongPin(id))
        r.error?.let {
            send(it)
            return
        }
        if (r.finished) return
        send(SignProgress(id, r.progress))
        r.certificates?.let { send(SignCertificate(id, it)) }
        for ((seq, signature) in r.signatures) send(SignSignature(id, seq, signature))
    }

    private fun progress(r: Active, stage: Stage) {
        r.progress = stage
        send(SignProgress(r.request.requestId, stage))
    }

    private fun setStep(r: Active, step: Step) {
        r.step = step
        render()
    }

    private fun send(message: PhoneToDesktop) {
        link?.send(message)
    }

    // ------------------------------------------------------------------------------------------
    // Rendering
    // ------------------------------------------------------------------------------------------

    private fun render() {
        val nfc = cardReader.nfc.value
        val current = active
        val candidate = proposed
        _screen.value = when {
            candidate != null -> Screen.ConfirmPairing(nfc, candidate, replacing = link != null)
            current != null -> Screen.Signing(nfc, current.review, current.step, link?.connected == true)
            link != null -> Screen.Home(nfc, linkStatus, pinRemembered = currentPin() != null, canSaved = store.get(KEY_CAN) != null)
            else -> Screen.Start(nfc, notice)
        }
    }

    private fun parseInstant(text: String): Long? = runCatching { Instant.parse(text).toEpochMilliseconds() }.getOrNull()

    companion object {
        const val KEY_PAIRING = "pairing"
        const val KEY_PAIRED_AT = "pairedAt"
        const val KEY_EXPIRES = "pairingExpiresAt"
        const val KEY_CAN = "can"
        const val CAN_LENGTH = 6
        private val CAN_PATTERN = Regex("[0-9]{6}")
        val PIN_LENGTH = 8..16
        const val PIN_CACHE_MS = 60 * 60_000L
        const val PAIRING_MAX_MS = 12 * 60 * 60_000L
        /** Waiting for the card again after it moved. */
        const val CARD_AGAIN_MS = 2 * 60_000L
        /** Waiting for the desktop's next to-be-signed blob (triphase servers can be slow). */
        const val NEXT_ITEM_MS = 60_000L
        const val RESULT_MS = 6_000L
    }
}

private fun Card.closeQuietly() = runCatching { close() }

internal fun hostOf(origin: String): String =
    origin.substringAfter("://").substringBefore('/').substringBefore(':').ifEmpty { origin }
