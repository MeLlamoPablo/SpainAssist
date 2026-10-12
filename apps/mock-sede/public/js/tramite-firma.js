/* Site code of the "Firmar y enviar" step: the way sedes drive AutoFirma through autoscript.js.
 * Used by the residencia review page and by the AutoFirma check on /ayuda/autofirma. */
document.addEventListener('DOMContentLoaded', () => {
  const form = document.getElementById('form-firma');
  if (!form) return;
  const button = document.getElementById('boton-firmar');
  const status = document.getElementById('estado-firma');
  const errorBox = document.getElementById('error-firma');

  // Sedes load the AutoFirma client as soon as the page is ready.
  AutoScript.cargarAppAfirma();

  const showError = (errorType, errorMessage) => {
    let text;
    if (errorType === 'es.gob.afirma.core.AOCancelledOperationException') {
      text = 'Has cancelado la firma. Puedes volver a intentarlo cuando quieras.';
    } else if (errorType === 'es.gob.afirma.standalone.ApplicationNotFoundException') {
      text = `${errorMessage} Comprueba que AutoFirma está instalado y vuelve a intentarlo.`;
    } else {
      text = `No se ha podido firmar: ${errorMessage || 'error desconocido'}`;
    }
    const p = document.createElement('p');
    p.textContent = text;
    errorBox.replaceChildren(p);
    if (errorType === 'es.gob.afirma.standalone.ApplicationNotFoundException') {
      const help = document.createElement('a');
      help.href = '/ayuda/autofirma';
      help.textContent = 'Cómo instalar AutoFirma';
      errorBox.append(help);
    }
    errorBox.hidden = false;
  };

  button.addEventListener('click', () => {
    errorBox.hidden = true;
    button.disabled = true;
    status.textContent =
      'Firmando… Si se abre AutoFirma, elige tu certificado y confirma la firma.';
    const dataB64 = form.elements.datos.value;
    AutoScript.sign(
      dataB64,
      'SHA256withRSA',
      'CAdES',
      'mode=implicit',
      (signatureB64, certificateB64) => {
        form.elements.firma.value = signatureB64;
        form.elements.certificado.value = certificateB64 || '';
        status.textContent = 'Firma realizada. Enviando…';
        form.submit();
      },
      (errorType, errorMessage) => {
        button.disabled = false;
        status.textContent = '';
        showError(errorType, errorMessage);
      },
    );
  });
});
