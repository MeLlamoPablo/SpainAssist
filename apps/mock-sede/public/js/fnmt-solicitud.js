/* Site code of the FNMT-like request page, the way FNMT's gestionPeticiones.js drives the
 * Configurador: check the form, rename the hidden preP10 field to PKCS10, ask
 * FnmtCertRequest.requestCert for the request and submit it; errors go to an alert(). */
// biome-ignore-all lint/suspicious/noVar: classic-script globals, like the original.
// biome-ignore-all lint/correctness/noUnusedVariables: enviarFormulario is the button's onclick.
// biome-ignore-all lint/complexity/useArrowFunction: written like the original ES5 script.
// biome-ignore-all lint/style/useTemplate: ES5 string concatenation, like the original.

function mostrarCargando(on) {
  var status = document.getElementById('estado-solicitud');
  var button = document.getElementById('botonEnviarFormulario');
  status.textContent = on ? 'Generando las claves del certificado…' : '';
  button.disabled = on;
}

function mostrarError(message) {
  var box = document.getElementById('error-solicitud');
  var p = document.createElement('p');
  p.className = 'alerta alerta-error';
  p.textContent = message;
  box.replaceChildren(p);
  box.hidden = false;
}

function validarFormulario() {
  var form = document.forms.formDatosUid;
  if (!form.NIF_SG.value.trim() || !form.APELLIDO1_SG.value.trim()) {
    mostrarError('Escribe tu documento de identificación y tu primer apellido.');
    return false;
  }
  if (!form.EMAIL_XX.value.trim() || form.EMAIL_XX.value !== form.EMAIL_OBLIG_VERIFICADO_XX.value) {
    mostrarError('Escribe tu correo electrónico dos veces, igual en los dos campos.');
    return false;
  }
  if (!form.aceptarCondiciones.checked) {
    mostrarError('Tienes que aceptar las condiciones de expedición del certificado.');
    return false;
  }
  return true;
}

function successCallback(pkcs10) {
  var form = document.forms.formDatosUid;
  form.PKCS10.value = pkcs10;
  mostrarCargando(true);
  form.submit();
}

function errorCallback(type, message) {
  var form = document.forms.formDatosUid;
  if (form.PKCS10) form.PKCS10.setAttribute('name', 'preP10');
  var text = message && message.substr(0, 4).toLowerCase() === 'err-' ? message.substr(9) : message;
  mostrarCargando(false);
  mostrarError(text || 'No se ha podido generar la petición de certificado (' + type + ').');
  alert(text || type);
}

function enviarFormulario() {
  if (!validarFormulario()) return;
  var form = document.forms.formDatosUid;
  form.preP10.setAttribute('name', 'PKCS10');
  mostrarCargando(true);
  FnmtCertRequest.requestCert(successCallback, errorCallback, 'RSA', null, null, false);
}
