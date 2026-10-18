package es.spainassist.firma.relay

import io.ktor.client.HttpClient
import io.ktor.client.plugins.websocket.DefaultClientWebSocketSession
import io.ktor.client.plugins.websocket.webSocket
import io.ktor.websocket.CloseReason
import io.ktor.websocket.Frame
import io.ktor.websocket.close
import io.ktor.websocket.readBytes
import io.ktor.websocket.readText
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Job
import kotlinx.coroutines.channels.Channel
import kotlinx.coroutines.delay
import kotlinx.coroutines.isActive
import kotlinx.coroutines.launch
import kotlinx.coroutines.withTimeoutOrNull
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.boolean
import kotlinx.serialization.json.jsonPrimitive
import kotlin.random.Random

/** Close codes of services/relay-server (RELAY_CLOSE in packages/shared). */
object RelayClose {
    const val UNAUTHORIZED: Short = 4401
    const val NOT_FOUND: Short = 4404
    const val EXPIRED: Short = 4408
    const val REPLACED: Short = 4409
    const val LIMITED: Short = 4429
}

sealed interface RelayState {
    data object Connecting : RelayState

    data class Open(val peer: Boolean) : RelayState

    /**
     * The relay doesn't know the room (4404). Rooms live in the relay's memory: after a restart
     * one comes back when the desktop reconnects, and only the desktop can create it. Still
     * trying, with a longer backoff; whoever listens decides when to give up ([RelayTransport.stop]).
     */
    data object Missing : RelayState

    /** Gave up: the room expired, or another phone took this one's place. */
    data class Closed(val reason: Reason) : RelayState {
        enum class Reason { NotFound, Expired, Replaced }
    }
}

/** One connection to the relay; `RelaySocket` is the real one, tests use in-memory ones. */
interface RelayTransport {
    fun start()

    fun stop()

    /** False when there is no open connection (the frame is dropped). */
    fun send(frame: ByteArray): Boolean
}

class RelayEvents(val onState: (RelayState) -> Unit, val onFrame: (ByteArray) -> Unit)

/**
 * The phone's connection to the relay (packages/companion/src/relay-socket.ts): reconnects with
 * backoff, reports whether the desktop is there, and keeps the connection alive with
 * `{"type":"ping"}` every 20 s (no pong in 10 s = reconnect). A room the relay doesn't know
 * ([RelayState.Missing]) is retried every [missingBackoffMs] (up to a minute): the relay may have
 * restarted before the desktop came back. Callbacks run in [scope], which the caller keeps serial.
 */
class RelaySocket(
    private val client: HttpClient,
    private val relayUrl: String,
    private val room: String,
    private val scope: CoroutineScope,
    private val events: RelayEvents,
    private val pingIntervalMs: Long = 20_000,
    private val pongTimeoutMs: Long = 10_000,
    private val backoffMs: (Int) -> Long = ::defaultBackoff,
    private val missingBackoffMs: (Int) -> Long = ::missingBackoff,
    /** Debug log; never given the room id (it lets anyone knock on the room). */
    private val log: (String) -> Unit = {},
) : RelayTransport {
    private var job: Job? = null
    private var session: DefaultClientWebSocketSession? = null
    private var stopped = false

    override fun start() {
        if (job?.isActive == true) return
        log("start ($relayUrl)")
        stopped = false
        job = scope.launch { run() }
    }

    /** Closes cleanly: frames already sent (a `bye`) leave before the close frame. */
    override fun stop() {
        log("stop")
        stopped = true
        val s = session
        val j = job
        session = null
        job = null
        if (s == null) {
            j?.cancel()
            return
        }
        scope.launch {
            withTimeoutOrNull(2_000) { runCatching { s.close(CloseReason(CloseReason.Codes.NORMAL, "")) } }
            j?.cancel()
        }
    }

    override fun send(frame: ByteArray): Boolean {
        val s = session
        if (s == null) {
            log("send dropped: not connected")
            return false
        }
        val sent = s.outgoing.trySend(Frame.Binary(true, frame)).isSuccess
        if (!sent) log("send dropped: socket closing")
        return sent
    }

    private suspend fun run() {
        var attempt = 0
        var missing = 0
        while (scope.isActive && !stopped) {
            events.onState(RelayState.Connecting)
            var code: Short? = null
            try {
                log("connecting (attempt ${attempt + 1})")
                client.webSocket("$relayUrl/v1/rooms/$room/phone") {
                    session = this
                    attempt = 0
                    log("open")
                    val pongs = Channel<Unit>(Channel.CONFLATED)
                    val pinger = launch {
                        while (isActive) {
                            delay(pingIntervalMs)
                            outgoing.send(Frame.Text("""{"type":"ping"}"""))
                            if (withTimeoutOrNull(pongTimeoutMs) { pongs.receive() } == null) {
                                log("pong timeout: reconnecting")
                                close(CloseReason(4000, "pong timeout"))
                                return@launch
                            }
                        }
                    }
                    try {
                        for (frame in incoming) {
                            when (frame) {
                                is Frame.Text -> control(frame.readText(), pongs)
                                is Frame.Binary -> events.onFrame(frame.readBytes())
                                else -> Unit
                            }
                        }
                    } finally {
                        pinger.cancel()
                        session = null
                    }
                    val reason = closeReason.await()
                    code = reason?.code
                    log("closed: code=${reason?.code} ${reason?.message.orEmpty()}")
                }
            } catch (e: CancellationException) {
                throw e
            } catch (e: Exception) {
                // Network errors: try again. The message may quote the URL, room id included.
                log("network error: ${e::class.simpleName} ${e.message?.replace(room, "<room>")}")
            }
            session = null
            if (stopped) return
            if (code != RelayClose.NOT_FOUND) missing = 0
            when (code) {
                RelayClose.NOT_FOUND -> {
                    events.onState(RelayState.Missing)
                    // The listener may have stopped us.
                    if (stopped) return
                    val wait = missingBackoffMs(missing++)
                    log("room not found: retrying in $wait ms")
                    delay(wait)
                    continue
                }
                // Only desktops present a key; a phone never gets this.
                RelayClose.UNAUTHORIZED -> {
                    events.onState(RelayState.Closed(RelayState.Closed.Reason.NotFound))
                    return
                }
                RelayClose.EXPIRED -> {
                    events.onState(RelayState.Closed(RelayState.Closed.Reason.Expired))
                    return
                }
                RelayClose.REPLACED -> {
                    events.onState(RelayState.Closed(RelayState.Closed.Reason.Replaced))
                    return
                }
            }
            events.onState(RelayState.Connecting)
            val wait = if (code == RelayClose.LIMITED) 30_000 else backoffMs(attempt++)
            log("reconnecting in $wait ms")
            delay(wait)
        }
    }

    private fun control(text: String, pongs: Channel<Unit>) {
        val message = runCatching { Json.parseToJsonElement(text) as? JsonObject }.getOrNull() ?: return
        when (message["type"]?.jsonPrimitive?.content) {
            "pong" -> pongs.trySend(Unit)
            "peer" -> {
                val present = runCatching { message["present"]?.jsonPrimitive?.boolean }.getOrNull() ?: return
                log("peer present=$present")
                events.onState(RelayState.Open(present))
            }
        }
    }
}

private fun defaultBackoff(attempt: Int): Long = jittered(minOf(15_000L, 500L shl minOf(attempt, 5)))

/** 1–2 s, 2–4 s… up to 30–60 s: the desktop recreates its room within 15 s of being online. */
private fun missingBackoff(attempt: Int): Long = jittered(minOf(60_000L, 2_000L shl minOf(attempt, 5)))

private fun jittered(base: Long): Long = base / 2 + Random.nextLong(base / 2 + 1)
