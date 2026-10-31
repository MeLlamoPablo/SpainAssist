/* Site code of the FNMT-like download page: hands the issued certificate to the Configurador
 * (FnmtCertRequest.installCert) as soon as the page is ready. */
// biome-ignore-all lint/suspicious/noVar: written like FNMT's ES5 scripts.
// biome-ignore-all lint/complexity/useArrowFunction: written like FNMT's ES5 scripts.
// biome-ignore-all lint/style/useTemplate: ES5 string concatenation, like FNMT's scripts.

document.addEventListener('DOMContentLoaded', function () {
  var data = document.getElementById('datos-certificado');
  if (!data) return;
  var status = document.getElementById('estado-instalacion');
  var errorBox = document.getElementById('error-instalacion');
  FnmtCertRequest.installCert(
    function () {
      status.textContent = 'Tu certificado se ha instalado correctamente.';
    },
    function (type, message) {
      status.textContent = '';
      var p = document.createElement('p');
      p.className = 'alerta alerta-error';
      p.textContent = 'No se ha podido instalar el certificado: ' + (message || type);
      errorBox.replaceChildren(p);
      errorBox.hidden = false;
      alert(message || type);
    },
    JSON.parse(data.textContent),
  );
});
