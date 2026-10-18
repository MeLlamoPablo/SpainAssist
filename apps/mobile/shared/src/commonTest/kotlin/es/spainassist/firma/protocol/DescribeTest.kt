package es.spainassist.firma.protocol

import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse

class DescribeTest {
    @Test
    fun leavesOutSecretsAndContent() {
        val request = SignRequest(
            requestId = "r1",
            purpose = Purpose.Document,
            origin = "https://sede.example.es/x",
            description = "Solicitud de Juan Pérez",
            format = "pades",
            documents = listOf(CompanionDocument("dni-12345678Z.pdf", "application/pdf", 3, "SHAHASH", "QUJD")),
            verifiable = true,
            expiresAt = "2026-10-12T10:00:00Z",
            can = "123456",
            pin = "secretpin1",
        )
        val lines = listOf(
            describe(request),
            describe(SignUnlock("r1", can = "654321", pin = "otherpin99", expiresAt = "2026-10-12T10:00:00Z")),
            describe(ToBeSigned("r1", 0, Algorithm.Sha256, data = "VEJTREFUQQ==")),
            describe(SignCertificate("r1", listOf("Q0VSVA=="))),
            describe(SignOtherCertificate("r1", "Q0VSVA==")),
            describe(SignSignature("r1", 0, "U0lHTkFUVVJF")),
            describe(SignNeed("r1", Need.Pin, refused = true, triesLeft = 2)),
        )
        val secrets = listOf(
            "123456", "654321", "secretpin1", "otherpin99", "QUJD", "VEJTREFUQQ", "Q0VSVA",
            "U0lHTkFUVVJF", "Juan", "12345678Z", "SHAHASH",
        )
        for (line in lines) {
            for (secret in secrets) assertFalse(secret in line, "\"$line\" quotes $secret")
        }
        assertEquals("sign.need r1 what=Pin refused=true triesLeft=2", lines.last())
    }
}
