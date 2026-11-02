/* Site code of the FNMT-like download page: hands the issued certificate to the Configurador
 * (FnmtCertRequest.installCert) as soon as the page is ready. Like FNMT's descarga.js, success
 * means ok(answer) with answer = base64 of "OK" (what the Configurador's answer decrypts to): the
 * page decodes it with atob, which throws on a missing answer, and anything but "OK" is an
 * irregular end. Then it says so in an alert, as FNMT's page does. */
// biome-ignore-all lint/suspicious/noVar: written like FNMT's ES5 scripts.
// biome-ignore-all lint/complexity/useArrowFunction: written like FNMT's ES5 scripts.
// biome-ignore-all lint/style/useTemplate: ES5 string concatenation, like FNMT's scripts.

document.addEventListener('DOMContentLoaded', function () {
  var data = document.getElementById('datos-certificado');
  if (!data) return;
  var status = document.getElementById('estado-instalacion');
  var errorBox = document.getElementById('error-instalacion');
  function showError(text) {
    status.textContent = '';
    var p = document.createElement('p');
    p.className = 'alerta alerta-error';
    p.textContent = text;
    errorBox.replaceChildren(p);
    errorBox.hidden = false;
  }
  FnmtCertRequest.installCert(
    function (answer) {
      if (atob(answer).trim() === 'OK') {
        status.textContent = 'Tu certificado se ha instalado correctamente.';
        alert('Tu certificado ha sido instalado con éxito');
      } else {
        showError('No se ha podido instalar el certificado.');
        alert(
          'El proceso de instalación ha terminado irregularmente, por favor, contacte con el servicio técnico',
        );
      }
    },
    function (type, message) {
      showError('No se ha podido instalar el certificado: ' + (message || type));
      alert(message || type);
    },
    JSON.parse(data.textContent),
  );
});
