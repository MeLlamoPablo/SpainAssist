package es.spainassist.firma.protocol

/**
 * A message for the debug log: its type, request id and plain fields only. Never the CAN, the
 * PIN, document data, data to sign, certificates or signatures.
 */
fun describe(message: DesktopToPhone): String = when (message) {
    is SignRequest -> "sign.request ${message.requestId} purpose=${message.purpose.name} " +
        "documents=${message.documents.size} verifiable=${message.verifiable} pin=${message.pin != null}"
    is SignUnlock -> "sign.unlock ${message.requestId} can=${message.can != null} pin=${message.pin != null}"
    is ToBeSigned -> "sign.toBeSigned ${message.requestId} seq=${message.seq} ${message.algorithm.name} " +
        "prehashed=${message.prehashed == true} check=${message.check != null}"
    is SignDone -> "sign.done ${message.requestId}"
    is SignCancel -> "sign.cancel ${message.requestId} reason=${message.reason.name}"
    DesktopBye -> "bye"
}

fun describe(message: PhoneToDesktop): String = when (message) {
    is SignProgress -> "sign.progress ${message.requestId} ${message.stage.name}"
    is SignCertificate -> "sign.certificate ${message.requestId} count=${message.certificates.size}"
    is SignSignature -> "sign.signature ${message.requestId} seq=${message.seq}"
    // The message is ours ("bad CAN"), never request data.
    is SignError -> "sign.error ${message.requestId} code=${message.code.name}" + (message.message?.let { " ($it)" } ?: "")
    is SignNeed -> "sign.need ${message.requestId} what=${message.what.name} refused=${message.refused} " +
        "triesLeft=${message.triesLeft}"
    PhoneBye -> "bye"
}
