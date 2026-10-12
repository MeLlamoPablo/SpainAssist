package es.spainassist.firma.sign

import es.spainassist.firma.VECTORS_JSON
import es.spainassist.firma.channel.Base64Std
import es.spainassist.firma.protocol.Algorithm
import es.spainassist.firma.protocol.Check
import es.spainassist.firma.protocol.CompanionJson
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import kotlin.test.Test
import kotlin.test.assertFalse
import kotlin.test.assertNotNull
import kotlin.test.assertNull
import kotlin.test.assertTrue

/** The checks run on what @sa/signer really sends (vectors/v1.json, "bindings"). */
class BindingTest {
    private val bindings = Json.parseToJsonElement(VECTORS_JSON).jsonObject.getValue("bindings").jsonObject

    private fun case(name: String): Triple<ByteArray, ByteArray, Check> {
        val c = bindings.getValue(name).jsonObject
        fun b64(key: String) = Base64Std.decode(c.getValue(key).jsonPrimitive.content)
        val check = CompanionJson.decodeFromJsonElement(Check.serializer(), c.getValue("check") as JsonObject)
        return Triple(b64("document"), b64("toBeSigned"), check)
    }

    @Test
    fun cmsBindsTheReviewedDocument() {
        val (document, toBeSigned, check) = case("cms")
        assertNotNull(Binding.messageDigest(toBeSigned))
        assertTrue(Binding.verify(check, Algorithm.Sha256, toBeSigned, listOf(document)))
        val other = document.copyOf().also { it[0] = (it[0] + 1).toByte() }
        assertFalse(Binding.verify(check, Algorithm.Sha256, toBeSigned, listOf(other)))
        assertFalse(Binding.verify(check, Algorithm.Sha512, toBeSigned, listOf(document)))
        assertFalse(Binding.verify(Check.Cms(1), Algorithm.Sha256, toBeSigned, listOf(document)))
        assertFalse(Binding.verify(check, Algorithm.Sha256, toBeSigned, listOf(null)))
    }

    @Test
    fun padesBindsThePdfAndOnlyASignatureUpdate() {
        val (pdf, toBeSigned, check) = case("pades")
        check as Check.Pades
        assertTrue(Binding.verify(check, Algorithm.Sha256, toBeSigned, listOf(pdf)))

        // Another PDF, or an update that brings new page content, is refused.
        val otherPdf = pdf.copyOf().also { it[pdf.size - 10] = 'X'.code.toByte() }
        assertFalse(Binding.verify(check, Algorithm.Sha256, toBeSigned, listOf(otherPdf)))
        val update = Base64Std.decode(check.update)
        val sneaky = update + "\n9 0 obj\n<< /Length 4 >>\nstream\nXXXX\nendstream\nendobj\n".encodeToByteArray()
        assertNull(Binding.padesCoveredBytes(pdf, sneaky, check.byteRange.dropLast(1) + (check.byteRange[3] + 55)))
        // The byte range must leave out exactly the zero-filled /Contents placeholder.
        val shifted = listOf(0L, check.byteRange[1] - 1, check.byteRange[2], check.byteRange[3])
        assertNull(Binding.padesCoveredBytes(pdf, update, shifted))
        assertNull(Binding.padesCoveredBytes(pdf, update, listOf(0L, 10L, check.byteRange[2], check.byteRange[3])))
    }

    @Test
    fun padesAllowsOnlyTheUpdatesOwnXRefStream() {
        val (pdf, _, check) = case("pades")
        check as Check.Pades
        val update = Base64Std.decode(check.update)
        fun covers(bytes: ByteArray) =
            Binding.padesCoveredBytes(pdf, bytes, check.byteRange.dropLast(1) + (pdf.size + bytes.size - check.byteRange[2]))
        val content = "9 0 obj\n<< /Length 4 >>\nstream\nXXXX\nendstream\nendobj\n"
        assertNotNull(covers(update + "% a comment\n".encodeToByteArray()))

        // `/Type /XRef` in a comment or a string, or in a content stream beside a classic table.
        assertNull(covers(update + "% /Type /XRef\n$content".encodeToByteArray()))
        assertNull(covers(update + "8 0 obj\n(/Type /XRef)\nendobj\n$content".encodeToByteArray()))
        assertNull(covers(update + content.replace("<< /Length 4 >>", "<< /Type /XRef /Length 4 >>").encodeToByteArray()))

        // The same objects with an xref stream (as @sa/signer writes for xref-stream files). Its
        // binary data may hold anything, delimiters and line ends included.
        val text = update.decodeToString()
        val objects = text.substring(0, text.indexOf("\nxref\n") + 1).encodeToByteArray()
        fun xrefStream(dict: String, at: Long = pdf.size.toLong() + objects.size, extra: String = "") =
            objects + "9 0 obj\n<< $dict /Length 7 >>\nstream\n".encodeToByteArray() +
                byteArrayOf(1, '('.code.toByte(), '%'.code.toByte(), '<'.code.toByte(), 0, '\n'.code.toByte(), '\r'.code.toByte()) +
                "\nendstream\nendobj\n${extra}startxref\n$at\n%%EOF\n".encodeToByteArray()
        assertNotNull(covers(xrefStream("/Type /XRef /Size 10 /W [1 4 2] /Index [1 1 3 1 5 2 9 1] /Root 1 0 R /ID [<aa> <bb>]")))
        assertNull(covers(xrefStream("/Type /XRef", at = pdf.size.toLong() + objects.size + 1)))
        assertNull(covers(xrefStream("/Subtype /Form /X << /Type /XRef >>")))
        assertNull(covers(xrefStream("/Type /XRef", extra = "3 0 obj\n<< /Contents 9 0 R >>\nendobj\n")))
        assertNull(covers(xrefStream("/Type /XRef", extra = "xref\n0 1\n0000000000 65535 f\r\ntrailer\n<< >>\n")))
        assertNull(covers(xrefStream("/Type /XRef") + content.encodeToByteArray()))
        // `/Type /XRef` only as an array item or split across other entries' keys and values.
        assertNull(covers(xrefStream("/Subtype /Form /F [/Type /XRef]")))
        assertNull(covers(xrefStream("/S /Type /XRef /N")))

        // A stream hidden from the tokenizer in a string or a comment: a reader still opens it
        // through the xref offset.
        assertNull(covers(update + "8 0 obj\n(9 0 obj << /Length 4 >> stream\nXXXX\nendstream endobj)\nendobj\n".encodeToByteArray()))
        assertNull(covers(update + "%9 0 obj << /Length 4 >> stream\r\nXXXX\nendstream\nendobj\n".encodeToByteArray()))
    }

    @Test
    fun rejectsWhatIsNotASetOfAttributes() {
        assertNull(Binding.messageDigest(byteArrayOf()))
        assertNull(Binding.messageDigest(byteArrayOf(0x30, 0x00)))
        assertNull(Binding.messageDigest(byteArrayOf(0x31, 0x05, 0x01)))
        assertNull(Binding.messageDigest(byteArrayOf(0x31, 0x00)))
    }
}
