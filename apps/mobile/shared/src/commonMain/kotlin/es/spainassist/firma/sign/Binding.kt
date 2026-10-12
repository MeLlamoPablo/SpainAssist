package es.spainassist.firma.sign

import es.spainassist.firma.channel.Base64Std
import es.spainassist.firma.channel.Crypto
import es.spainassist.firma.protocol.Algorithm
import es.spainassist.firma.protocol.Check

/**
 * Checks, before the card signs, that a to-be-signed blob belongs to a document the user
 * reviewed (the `check` of `sign.toBeSigned`, see packages/shared/src/companion.ts):
 * - `cms`: the blob is a DER SET of CMS attributes whose messageDigest is the document's hash;
 * - `pades`: the signed PDF is the document plus `update`; the messageDigest is the hash of its
 *   /ByteRange, the gap is the zero-filled hex /Contents placeholder inside the update, and the
 *   update adds no new content streams. The only stream it may hold is its own cross-reference
 *   stream: an object whose dictionary says `/Type /XRef`, that `startxref` points to, that
 *   nothing references, and with no classic `xref` table beside it. Comments, strings and
 *   stream data are skipped when looking for keywords.
 */
object Binding {
    /** OID 1.2.840.113549.1.9.4 (messageDigest). */
    private val MESSAGE_DIGEST = byteArrayOf(0x2a, 0x86.toByte(), 0x48, 0x86.toByte(), 0xf7.toByte(), 0x0d, 0x01, 0x09, 0x04)

    fun verify(check: Check, algorithm: Algorithm, toBeSigned: ByteArray, documents: List<ByteArray?>): Boolean {
        val document = documents.getOrNull(check.document) ?: return false
        val digest = messageDigest(toBeSigned) ?: return false
        return when (check) {
            is Check.Cms -> digest.contentEquals(Crypto.digest(algorithm.digest, document))
            is Check.Pades -> {
                val update = runCatching { Base64Std.decode(check.update) }.getOrNull() ?: return false
                val covered = padesCoveredBytes(document, update, check.byteRange) ?: return false
                digest.contentEquals(Crypto.digest(algorithm.digest, covered))
            }
        }
    }

    /** The messageDigest value of a DER `SET OF Attribute`, or null when it isn't one. */
    fun messageDigest(attributes: ByteArray): ByteArray? {
        val set = Der.read(attributes, 0) ?: return null
        if (set.tag != 0x31 || set.end != attributes.size) return null
        var found: ByteArray? = null
        for (attribute in Der.children(attributes, set)) {
            if (attribute.tag != 0x30) return null
            val parts = Der.children(attributes, attribute)
            if (parts.size != 2 || parts[0].tag != 0x06 || parts[1].tag != 0x31) return null
            if (!attributes.copyOfRange(parts[0].start, parts[0].end).contentEquals(MESSAGE_DIGEST)) continue
            val values = Der.children(attributes, parts[1])
            if (found != null || values.size != 1 || values[0].tag != 0x04) return null
            found = attributes.copyOfRange(values[0].start, values[0].end)
        }
        return found
    }

    /** The bytes a PAdES signature covers, or null when the update isn't a plain signature update. */
    fun padesCoveredBytes(document: ByteArray, update: ByteArray, byteRange: List<Long>): ByteArray? {
        if (byteRange.size != 4) return null
        val total = document.size.toLong() + update.size
        val (a, b, c, d) = byteRange
        if (a != 0L || b <= document.size || c <= b || c + d != total || d < 0) return null
        val pdf = document + update
        val gap = pdf.copyOfRange(b.toInt(), c.toInt())
        if (gap.size < 3 || gap.first() != '<'.code.toByte() || gap.last() != '>'.code.toByte()) return null
        for (i in 1 until gap.size - 1) if (gap[i] != '0'.code.toByte()) return null
        // An update may rewrite objects (catalog, page, AcroForm) but must not bring content.
        if (!PdfUpdate.hasNoContentStream(update, document.size.toLong())) return null
        return pdf.copyOfRange(0, b.toInt()) + pdf.copyOfRange(c.toInt(), total.toInt())
    }
}

/** Just enough PDF syntax to tell a signature update's own XRef stream from added content. */
internal object PdfUpdate {
    private enum class Kind { Name, Regular, DictOpen, DictClose, Other }

    private class Token(val kind: Kind, val start: Int, val text: String)

    private class Stream(val tokens: List<Token>, val objectStart: Int)

    private const val DELIMITERS = "()<>[]{}/%"

    private fun isWhite(c: Char) = c == ' ' || c == '\n' || c == '\r' || c == '\t' || c == '\u000c' || c == '\u0000'

    private fun isRegular(c: Char) = !isWhite(c) && c !in DELIMITERS

    /**
     * True when [update] holds no stream, or only its own cross-reference stream: see [Binding].
     * [offset] is where the update starts in the signed PDF.
     */
    fun hasNoContentStream(update: ByteArray, offset: Long): Boolean {
        val text = CharArray(update.size) { (update[it].toInt() and 0xff).toChar() }.concatToString()
        val tokens = ArrayList<Token>()
        val streams = ArrayList<Stream>()
        var i = 0
        while (i < text.length) {
            val c = text[i]
            when {
                isWhite(c) -> i++
                c == '%' -> while (i < text.length && text[i] != '\n' && text[i] != '\r') i++
                c == '(' -> {
                    var depth = 0
                    while (true) {
                        if (i >= text.length) return false
                        when (text[i]) {
                            '\\' -> i++
                            '(' -> depth++
                            ')' -> depth--
                        }
                        i++
                        if (depth == 0) break
                    }
                    tokens += Token(Kind.Other, i, "")
                }
                c == '<' && text.startsWith("<<", i) -> {
                    tokens += Token(Kind.DictOpen, i, "<<")
                    i += 2
                }
                c == '>' && text.startsWith(">>", i) -> {
                    tokens += Token(Kind.DictClose, i, ">>")
                    i += 2
                }
                c == '<' -> {
                    val end = text.indexOf('>', i)
                    if (end < 0) return false
                    tokens += Token(Kind.Other, i, "")
                    i = end + 1
                }
                c == '/' -> {
                    val start = i++
                    while (i < text.length && isRegular(text[i])) i++
                    tokens += Token(Kind.Name, start, text.substring(start, i))
                }
                isRegular(c) -> {
                    val start = i
                    while (i < text.length && isRegular(text[i])) i++
                    val word = text.substring(start, i)
                    if (word != "stream") {
                        tokens += Token(Kind.Regular, start, word)
                        continue
                    }
                    // `N G obj << ... >> stream`: skip /Length bytes of data up to `endstream`.
                    val obj = tokens.indexOfLast { it.kind == Kind.Regular && it.text == "obj" }
                    if (obj < 2 || tokens.subList(obj, tokens.size).any { it.text == "endobj" }) return false
                    val head = tokens.subList(obj - 2, tokens.size).toList()
                    if (head[0].text.toIntOrNull() == null || head[1].text.toIntOrNull() == null) return false
                    val length = entry(head, "/Length")?.text?.toIntOrNull() ?: return false
                    if (text.startsWith("\r\n", i)) i += 2 else if (text.startsWith("\n", i) || text.startsWith("\r", i)) i++ else return false
                    if (length < 0 || length > text.length - i) return false
                    i += length
                    if (text.startsWith("\r\n", i)) i += 2 else if (text.startsWith("\n", i) || text.startsWith("\r", i)) i++
                    if (!text.startsWith("endstream", i) || (i + 9 < text.length && isRegular(text[i + 9]))) return false
                    i += 9
                    streams += Stream(head, head[0].start)
                    tokens += Token(Kind.Other, start, "")
                }
                else -> {
                    tokens += Token(Kind.Other, i, c.toString())
                    i++
                }
            }
        }
        // Readers jump to objects by xref offset, so one hidden in a string or a comment (or in
        // the xref stream's own data) still opens. Every raw `stream` keyword must be one we read.
        if (rawStreamKeywords(text) != streams.size) return false
        if (streams.isEmpty()) return true
        val stream = streams.singleOrNull() ?: return false
        val number = stream.tokens[0].text
        if (entry(stream.tokens, "/Type")?.text != "/XRef") return false
        if (tokens.any { it.kind == Kind.Regular && it.text == "xref" }) return false
        val startxref = tokens.indexOfLast { it.kind == Kind.Regular && it.text == "startxref" }
        if (startxref < 0 || tokens.getOrNull(startxref + 1)?.text?.toLongOrNull() != offset + stream.objectStart) return false
        // Nothing may use it as an object (`N G R`).
        for (k in 2 until tokens.size) {
            if (tokens[k].text == "R" && tokens[k - 2].text == number && tokens[k - 1].text.toIntOrNull() != null) return false
        }
        return true
    }

    /** Occurrences of the word `stream` anywhere in [text] (not `endstream`). */
    private fun rawStreamKeywords(text: String): Int {
        var count = 0
        var at = text.indexOf("stream")
        while (at >= 0) {
            val before = at == 0 || !isRegular(text[at - 1])
            val after = at + 6 >= text.length || !isRegular(text[at + 6])
            if (before && after) count++
            at = text.indexOf("stream", at + 1)
        }
        return count
    }

    /**
     * The direct value token of [key] among the top-level entries of the dictionary that follows
     * `N G obj` in [head], or null when it's missing, repeated, indirect (`N G R`) or not a single
     * token.
     */
    private fun entry(head: List<Token>, key: String): Token? {
        val end = head.size - 1
        if (head.size < 5 || head[3].kind != Kind.DictOpen || head[end].kind != Kind.DictClose) return null
        var found: Token? = null
        var k = 4
        while (k < end) {
            val name = head[k]
            if (name.kind != Kind.Name) return null
            val start = ++k
            if (k >= end) return null
            val first = head[k]
            when {
                first.kind == Kind.DictOpen || first.text == "[" -> {
                    // Skip the nested dictionary or array.
                    var depth = 0
                    do {
                        val t = head[k]
                        if (t.kind == Kind.DictOpen || t.text == "[") depth++
                        if (t.kind == Kind.DictClose || t.text == "]") depth--
                        k++
                    } while (depth > 0 && k < end)
                    if (depth != 0) return null
                }
                first.kind == Kind.DictClose || first.text == "]" -> return null
                first.text.toIntOrNull() != null && head.getOrNull(k + 1)?.text?.toIntOrNull() != null &&
                    head.getOrNull(k + 2)?.text == "R" && k + 2 < end -> k += 3
                else -> k++
            }
            if (name.text == key) {
                if (found != null || k - start != 1) return null
                found = head[start]
            }
        }
        return found
    }
}

/** Just enough DER to walk CMS attributes. */
internal object Der {
    class Node(val tag: Int, val start: Int, val end: Int)

    /** The TLV at [at]: `start`/`end` delimit its content. */
    fun read(bytes: ByteArray, at: Int): Node? {
        if (at + 2 > bytes.size) return null
        val tag = bytes[at].toInt() and 0xff
        if (tag and 0x1f == 0x1f) return null
        var length = bytes[at + 1].toInt() and 0xff
        var start = at + 2
        if (length and 0x80 != 0) {
            val count = length and 0x7f
            if (count == 0 || count > 4 || start + count > bytes.size) return null
            length = 0
            for (i in 0 until count) length = (length shl 8) or (bytes[start + i].toInt() and 0xff)
            start += count
            if (length < 0) return null
        }
        val end = start + length
        if (end > bytes.size || end < start) return null
        return Node(tag, start, end)
    }

    fun children(bytes: ByteArray, parent: Node): List<Node> {
        val out = ArrayList<Node>()
        var at = parent.start
        while (at < parent.end) {
            val node = read(bytes, at) ?: return emptyList()
            if (node.end > parent.end) return emptyList()
            out += node
            at = node.end
        }
        return out
    }
}
