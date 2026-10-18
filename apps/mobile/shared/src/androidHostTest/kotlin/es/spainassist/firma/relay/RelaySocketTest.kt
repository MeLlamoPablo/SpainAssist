package es.spainassist.firma.relay

import io.ktor.client.HttpClient
import io.ktor.client.engine.cio.CIO
import io.ktor.client.plugins.websocket.WebSockets
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.delay
import kotlinx.coroutines.newSingleThreadContext
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.withTimeout
import java.io.InputStream
import java.io.OutputStream
import java.net.InetAddress
import java.net.ServerSocket
import java.net.Socket
import java.security.MessageDigest
import java.util.Base64
import java.util.Collections
import kotlin.concurrent.thread
import kotlin.test.AfterTest
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertTrue

/**
 * [RelaySocket] over a real socket, against a minimal WebSocket server that behaves like
 * services/relay-server for one room: 4404 while the room doesn't exist, `peer` once it does.
 */
@OptIn(ExperimentalCoroutinesApi::class)
class RelaySocketTest {
    private class FakeRelay : AutoCloseable {
        private val server = ServerSocket(0, 50, InetAddress.getLoopbackAddress())
        private val open = Collections.synchronizedList(ArrayList<Socket>())

        @Volatile var roomExists = false

        @Volatile var connections = 0
        val url = "ws://127.0.0.1:${server.localPort}"

        init {
            thread(isDaemon = true) {
                while (!server.isClosed) {
                    val socket = runCatching { server.accept() }.getOrNull() ?: break
                    connections++
                    open += socket
                    thread(isDaemon = true) { runCatching { serve(socket) } }
                }
            }
        }

        private fun serve(socket: Socket) {
            val input = socket.getInputStream()
            val output = socket.getOutputStream()
            val headers = readHeaders(input)
            val key = headers.lineSequence().first { it.startsWith("Sec-WebSocket-Key:", ignoreCase = true) }
                .substringAfter(':').trim()
            val accept = Base64.getEncoder().encodeToString(
                MessageDigest.getInstance("SHA-1").digest("${key}258EAFA5-E914-47DA-95CA-C5AB0DC85B11".toByteArray()),
            )
            output.write(
                "HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: $accept\r\n\r\n"
                    .toByteArray(),
            )
            if (roomExists) {
                frame(output, 0x1, """{"type":"peer","present":false}""".toByteArray())
            } else {
                frame(output, 0x8, byteArrayOf((4404 shr 8).toByte(), (4404 and 0xff).toByte()) + "no such room".toByteArray())
            }
            output.flush()
            // Until the client closes (its close frame, then EOF) or the test ends.
            while (input.read() >= 0) continue
            socket.close()
        }

        private fun readHeaders(input: InputStream): String {
            val bytes = StringBuilder()
            while (!bytes.endsWith("\r\n\r\n")) {
                val b = input.read()
                if (b < 0) error("EOF in headers")
                bytes.append(b.toChar())
            }
            return bytes.toString()
        }

        private fun frame(output: OutputStream, opcode: Int, payload: ByteArray) {
            require(payload.size < 126)
            output.write(byteArrayOf((0x80 or opcode).toByte(), payload.size.toByte()) + payload)
        }

        override fun close() {
            server.close()
            synchronized(open) { open.forEach { runCatching { it.close() } } }
        }
    }

    private val relay = FakeRelay()
    private val thread = newSingleThreadContext("relay")
    private val client = HttpClient(CIO) { install(WebSockets) }

    @AfterTest
    fun tearDown() {
        client.close()
        relay.close()
        thread.close()
    }

    @Test
    fun keepsRetryingAMissingRoomUntilItIsBack() = runBlocking<Unit> {
        val states = Collections.synchronizedList(ArrayList<RelayState>())
        val missingAttempts = Collections.synchronizedList(ArrayList<Int>())
        val socket = RelaySocket(
            client,
            relay.url,
            "room",
            CoroutineScope(thread),
            RelayEvents(onState = { states += it }, onFrame = {}),
            pingIntervalMs = 60_000,
            backoffMs = { 10 },
            missingBackoffMs = { missingAttempts += it; 20 },
        )
        socket.start()
        withTimeout(10_000) { while (states.count { it == RelayState.Missing } < 3) delay(10) }
        // The desktop reconnects and recreates the room.
        relay.roomExists = true
        withTimeout(10_000) { while (RelayState.Open(peer = false) !in states) delay(10) }
        socket.stop()

        assertTrue(states.none { it is RelayState.Closed }, "states: $states")
        // The longer backoff grows across consecutive refusals.
        assertEquals((0 until missingAttempts.size).toList(), missingAttempts.toList())
        assertTrue(relay.connections >= 4)
    }

    @Test
    fun stopsWhenTheListenerGivesUp() = runBlocking<Unit> {
        val states = Collections.synchronizedList(ArrayList<RelayState>())
        lateinit var socket: RelaySocket
        socket = RelaySocket(
            client,
            relay.url,
            "room",
            CoroutineScope(thread),
            RelayEvents(onState = { states += it; if (it == RelayState.Missing) socket.stop() }, onFrame = {}),
            pingIntervalMs = 60_000,
            backoffMs = { 10 },
            missingBackoffMs = { 10 },
        )
        socket.start()
        withTimeout(10_000) { while (RelayState.Missing !in states) delay(10) }
        delay(300)
        assertEquals(1, relay.connections)
        assertEquals(1, states.count { it == RelayState.Missing })
    }
}
