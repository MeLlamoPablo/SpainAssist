/* Imitation of FNMT's fnmtcertrq.js (written for this mock; no FNMT code). Same global and
 * public members as the real script: a top-level `var FnmtCertRequest` assigned from an IIFE.
 * The real one launches the Configurador through `fnmtcr://` and polls a relay for its answer;
 * there is no Configurador here, so requestCert and installCert fail after a short wait, as the
 * real page does once it gives up. The app's shim replaces this object before the page uses it. */
// biome-ignore-all lint/suspicious/noVar: classic-script globals, like the original.
// biome-ignore-all lint/correctness/noUnusedVariables: these globals are the script's public API.
// biome-ignore-all lint/complexity/useArrowFunction: written like the original ES5 script.
// biome-ignore-all lint/correctness/noInnerDeclarations: ES5 var declarations, like the original.
// biome-ignore-all lint/correctness/noUnusedFunctionParameters: methods keep the original signatures.

var FnmtCertRequest = (function (win, undef) {
  var VERSION = '1.6.4';
  var WAIT_MS = 3000;
  var lastError = { type: '', message: '' };

  function notFound(ko) {
    win.setTimeout(function () {
      lastError.type = 'es.gob.fnmt.cert.certrequest.ApplicationNotFoundException';
      lastError.message =
        'La aplicación FNMT de solicitud de certificados no se encuentra instalada en el sistema.';
      if (typeof ko === 'function') ko(lastError.type, lastError.message);
    }, WAIT_MS);
  }

  return {
    VERSION: VERSION,
    cargarAppFnmt: function (servletBase) {},
    setServlets: function (storage, retrieve) {},
    requestCert: function (ok, ko, keyType, keyLength, csrType, forceCard) {
      notFound(ko);
    },
    installCert: function (ok, ko, cert) {
      if (cert == null || cert === undef) {
        lastError.type = 'java.lang.IllegalArgumentException';
        lastError.message = 'No se ha recibido el certificado del servidor';
        throw new Error();
      }
      notFound(ko);
    },
    getBase64FromText: function (text) {
      if (text == null) return null;
      var bytes = new TextEncoder().encode(text);
      var binary = '';
      for (var i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]);
      return win.btoa(binary);
    },
    getTextFromBase64: function (b64) {
      var binary = win.atob(b64);
      var bytes = new Uint8Array(binary.length);
      for (var i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
      return new TextDecoder().decode(bytes);
    },
    downloadRemoteData: function (url, ok, ko) {},
    getErrorMessage: function () {
      return lastError.message;
    },
    getErrorType: function () {
      return lastError.type;
    },
    isAndroid: function () {
      return navigator.userAgent.toUpperCase().indexOf('ANDROID') !== -1;
    },
    isIOS: function () {
      return /IPAD|IPOD|IPHONE/.test(navigator.userAgent.toUpperCase());
    },
  };
})(window, undefined);
