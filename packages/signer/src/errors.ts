/**
 * Errors reported to the page the way AutoFirma 1.10 + autoscript 1.10.1 report them:
 * `errorCallback(errorType, errorMessage, errorCode)`.
 *
 * AutoFirma sends `err-NN:=<AF code> - <message>`; autoscript turns `err-11` (cancellation)
 * into `es.gob.afirma.core.AOCancelledOperationException` and every other error into
 * `java.lang.Exception`, keeping the 8-character code. Codes and messages below are AutoFirma's
 * (`es.gob.afirma.core.ErrorCode` and friends); `AS` codes are autoscript's own.
 */

export const CANCELLED_TYPE = 'es.gob.afirma.core.AOCancelledOperationException';
export const GENERIC_TYPE = 'java.lang.Exception';

export class AfirmaError extends Error {
  readonly errorType: string;
  readonly errorCode: string;

  constructor(errorType: string, message: string, errorCode: string) {
    super(message);
    this.name = 'AfirmaError';
    this.errorType = errorType;
    this.errorCode = errorCode;
  }

  private static generic(code: string, message: string): AfirmaError {
    return new AfirmaError(GENERIC_TYPE, message, code);
  }

  /** The user rejected the signature or closed the prompt ("CANCEL" in autoscript). */
  static cancelled(): AfirmaError {
    return new AfirmaError(CANCELLED_TYPE, 'Operacion cancelada por el usuario', 'AS500001');
  }

  static unsupportedFormat(format: string): AfirmaError {
    return AfirmaError.generic(
      'AF600105',
      `El formato de firma indicado en la operacion de firma no esta soportado: ${format}`,
    );
  }

  static unsupportedAlgorithm(algorithm: string): AfirmaError {
    return AfirmaError.generic('AF600107', `Algoritmo de firma no soportado: ${algorithm}`);
  }

  static unsupportedOperation(what: string): AfirmaError {
    return AfirmaError.generic('AF600002', `Operacion no soportada: ${what}`);
  }

  static invalidParameter(message: string): AfirmaError {
    return AfirmaError.generic('AF600121', message);
  }

  static noData(): AfirmaError {
    return AfirmaError.generic('AF600100', 'No se han proporcionado los datos a firmar');
  }

  static invalidData(
    message = 'Los datos proporcionados no tienen un formato valido',
  ): AfirmaError {
    return AfirmaError.generic('AF501002', message);
  }

  static notPdf(): AfirmaError {
    return AfirmaError.generic('AF510005', 'Los datos no son un documento PDF valido');
  }

  static notXml(): AfirmaError {
    return AfirmaError.generic('AF510002', 'Los datos no son un documento XML valido');
  }

  static notSignature(): AfirmaError {
    return AfirmaError.generic('AF501006', 'Los datos proporcionados no son una firma valida');
  }

  static noCertificate(code = 'AF501001'): AfirmaError {
    return AfirmaError.generic(code, 'No se encontraron certificados con los que firmar');
  }

  /**
   * The page's certificate filters accept only the DNI's AUTENTICACIÓN certificate, and
   * documents are signed only with FIRMA (AutoFirma would find no certificate either way).
   */
  static authenticationOnly(): AfirmaError {
    return AfirmaError.generic(
      'AF501001',
      'No se encontraron certificados con los que firmar: el sitio solo admite el certificado de autenticacion del DNI, que no se usa para firmar documentos',
    );
  }

  static triphase(phase: 'pre' | 'post', serverMessage: string): AfirmaError {
    return AfirmaError.generic(
      phase === 'pre' ? 'AF300451' : 'AF300452',
      `Error en la ${phase === 'pre' ? 'prefirma' : 'postfirma'} del servidor: ${serverMessage}`,
    );
  }

  static network(phase: 'pre' | 'post' | 'batch', detail: string): AfirmaError {
    const code = phase === 'pre' ? 'AF401300' : phase === 'post' ? 'AF401400' : 'AF401500';
    return AfirmaError.generic(code, `No se pudo conectar con el servidor de firma: ${detail}`);
  }

  /** HTTP error status from a triphase / batch server (AOCAdESTriPhaseSigner mapping). */
  static http(phase: 'pre' | 'post' | 'batch', status: number): AfirmaError {
    const pre = phase !== 'post';
    let code: string;
    if (status === 400) code = pre ? 'AF600701' : 'AF600702';
    else if (status >= 500) code = pre ? 'AF300400' : 'AF300404';
    else code = pre ? 'AF401301' : 'AF401401';
    return AfirmaError.generic(code, `El servidor de firma respondio con el error HTTP ${status}`);
  }

  static internal(message: string): AfirmaError {
    return AfirmaError.generic('AF200115', message);
  }
}

/** Converts anything thrown while handling an operation into an AutoFirma-style error. */
export function toAfirmaError(e: unknown): AfirmaError {
  if (e instanceof AfirmaError) return e;
  const message = e instanceof Error ? e.message : String(e);
  return AfirmaError.internal(`Error interno al firmar: ${message}`);
}
