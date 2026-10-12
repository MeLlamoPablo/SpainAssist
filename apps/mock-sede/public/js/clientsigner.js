/*
 * clientSigner.js for the SpainAssist mock sede ("gsede" login).
 *
 * An imitation (not the original code) of the AutoFirma wrapper that some municipal sedes built
 * on the gsede platform serve after their own copy of autoscript.js 1.8.x (the mock server
 * concatenates both into /gsede/js/clientSigner.js, see src/assets.ts). Its login flow:
 *   authenticate([{mode, format, hashToSign, algorithm, transactionId, ...}], 'callbackName')
 *   -> after 500 ms: setForceWSMode, checkTime, setLocale, setWaitCertMaxLoops,
 *      setWaitCertTimeout, cargarAppAfirma (or cargarMiniApplet)
 *   -> setServlets + AutoScript.signBatch(<signbatch> XML, BatchPresigner, BatchPostsigner, ...)
 *   -> for every DONE_AND_SAVED result, GET RetrieveService?op=get&v=1_0&id=<transactionId>
 *      ("<b64u certificate>|<b64u signature>")
 *   -> callback(JSON.stringify([{signature, transactionId}, ..., {certificate}]))
 * With signerClientMultiNode the batch servlets get "/service/<JSESSIONID>" appended. Errors
 * end in alert("Ha ocurrido un error al firmar: ...") unless the page set an error callback.
 */
// biome-ignore-all lint/suspicious/noVar: classic-script globals, like the original.
// biome-ignore-all lint/correctness/noUnusedVariables: these globals are the script's public API.
// biome-ignore-all lint/complexity/useArrowFunction: written like the original ES5 script.
// biome-ignore-all lint/style/useTemplate: ES5 string concatenation, like the original.
// biome-ignore-all lint/correctness/noInnerDeclarations: ES5 var declarations, like the original.
// biome-ignore-all lint/correctness/noUnusedFunctionParameters: callbacks keep the original signatures.

var clientSignerAfirma5 = { callback: sign_complete, errorCallback: null, form: 'datosFirma' };
var result = [];
var config;
var scBaseAddress;

function authenticate(signConfig, callback) {
  clientSignerAfirma5.form = 'formLogin';
  sign(signConfig, callback);
}

function sign(signConfig, callback, errorCallbackFn) {
  dosign(signConfig, callback, errorCallbackFn, 'sign');
}

function cosign(signConfig, callback, errorCallbackFn) {
  dosign(signConfig, callback, errorCallbackFn, 'cosign');
}

function countersign(signConfig, callback, errorCallbackFn) {
  dosign(signConfig, callback, errorCallbackFn, 'countersign');
}

function isEmpty(value) {
  return value === undefined || value === null || value === '';
}

function dosign(signConfig, callback, errorCallbackFn, operation) {
  result = [];
  config = signConfig;
  var checkTimeMode = isEmpty(window.signerClientCheckTimeMode)
    ? AutoScript.CHECKTIME_RECOMMENDED
    : window.signerClientCheckTimeMode;
  var maxMillis = isEmpty(window.signerClientCheckTimeMaxMillis)
    ? 60000
    : window.signerClientCheckTimeMaxMillis;
  var locale = isEmpty(window.signerClientLocale) ? 'es_ES' : window.signerClientLocale;
  scBaseAddress = getBaseAddress(isEmpty(window.signerClientBase) ? './' : window.signerClientBase);
  var forceWsMode = window.signerClientForceWSMode === true;
  var forceAutofirma = window.signerClientForceAutofirma === true || window.forceAutofirma === true;
  var multiNode = window.signerClientMultiNode === true;
  var waitCertMaxLoops = isEmpty(window.waitCertMaxLoops) ? 15 : window.waitCertMaxLoops;
  var waitCertTimeout = isEmpty(window.waitCertTimeout) ? 4000 : window.waitCertTimeout;
  setTimeout(function () {
    AutoScript.setForceWSMode(forceWsMode);
    AutoScript.checkTime(checkTimeMode, maxMillis, scBaseAddress + '/checktimeurl');
    AutoScript.setLocale(locale);
    AutoScript.setWaitCertMaxLoops(waitCertMaxLoops);
    AutoScript.setWaitCertTimeout(waitCertTimeout);
    if (forceAutofirma) AutoScript.cargarAppAfirma(scBaseAddress);
    else AutoScript.cargarMiniApplet(scBaseAddress);
    terminateSign(signConfig, operation, callback, errorCallbackFn, multiNode);
  }, 500);
}

function terminateSign(signConfig, operation, callback, errorCallbackFn, multiNode) {
  if (callback != null) {
    clientSignerAfirma5.callback = typeof callback === 'string' ? window[callback] : callback;
  }
  if (errorCallbackFn != null) {
    clientSignerAfirma5.errorCallback =
      typeof errorCallbackFn === 'string' ? window[errorCallbackFn] : errorCallbackFn;
  }
  var first = signConfig[0];
  var params = '';
  if (first.mode === 'implicit') {
    params += 'mode=implicit\n';
  } else {
    params += 'mode=explicit\n';
    if (first.algorithm === 'SHA1withRSA') params += 'precalculatedHashAlgorithm=SHA-1\n';
    else if (first.algorithm === 'SHA256withRSA') params += 'precalculatedHashAlgorithm=SHA-256\n';
    else if (first.algorithm === 'SHA384withRSA') params += 'precalculatedHashAlgorithm=SHA-384\n';
    else if (first.algorithm === 'SHA512withRSA') params += 'precalculatedHashAlgorithm=SHA-512\n';
  }
  if (first.policy === 'true' || first.policy === '1.9') params += 'expPolicy=FirmaAGE\n';
  if (first.useManifest === 'true') params += 'useManifest=true\n';

  var retrieveUrl = scBaseAddress + '/clientsigner/RetrieveService';
  var storageUrl = scBaseAddress + '/clientsigner/StorageService';
  var presignerUrl = scBaseAddress + '/clientsigner/BatchPresigner';
  var postsignerUrl = scBaseAddress + '/clientsigner/BatchPostsigner';
  if (multiNode) {
    console.log('Clientsigner configurado en modo multinodo.');
    var sessionId = getJSessionId();
    if (sessionId) {
      retrieveUrl += '/service/' + sessionId;
      storageUrl += '/service/' + sessionId;
      presignerUrl += '/service/' + sessionId;
      postsignerUrl += '/service/' + sessionId;
    } else {
      console.warn('No se ha podido recuperar el jsessionid.');
    }
  }
  AutoScript.setServlets(storageUrl, retrieveUrl);
  AutoScript.signBatch(
    Base64.encode(calculateBatchXml(signConfig, params, operation)),
    presignerUrl,
    postsignerUrl,
    params,
    successBatchCallback,
    errorCallback,
  );
}

function calculateBatchXml(signConfig, params, operation) {
  var doc = document.implementation.createDocument(null, 'signbatch', null);
  var root = doc.documentElement;
  root.setAttribute('stoponerror', 'true');
  root.setAttribute('algorithm', signConfig[0].algorithm);
  for (var i = 0; i < signConfig.length; i++) {
    var item = signConfig[i];
    if (item.transactionId == null || item.transactionId === '')
      item.transactionId = generateUUID();
    var single = doc.createElement('singlesign');
    single.setAttribute('Id', item.transactionId);
    var element = doc.createElement('datasource');
    element.appendChild(doc.createTextNode(item.hashToSign));
    single.appendChild(element);
    element = doc.createElement('format');
    element.appendChild(doc.createTextNode(item.format));
    single.appendChild(element);
    element = doc.createElement('suboperation');
    element.appendChild(doc.createTextNode(operation));
    single.appendChild(element);
    element = doc.createElement('extraparams');
    element.appendChild(doc.createTextNode(Base64.encode(params)));
    single.appendChild(element);
    var saver = doc.createElement('signsaver');
    element = doc.createElement('class');
    element.appendChild(doc.createTextNode('es.mocksede.clientsigner.SignSaverFile'));
    saver.appendChild(element);
    saver.appendChild(doc.createElement('config'));
    single.appendChild(saver);
    root.appendChild(single);
  }
  return new XMLSerializer().serializeToString(doc);
}

function successBatchCallback(resultB64) {
  var results = new DOMParser()
    .parseFromString(Base64.decode(resultB64), 'text/xml')
    .getElementsByTagName('signresult');
  for (var i = 0; i < results.length; i++) {
    var state = results[i].getAttribute('result');
    if (state === 'DONE_AND_SAVED' || state === 'DONE_BUT_NOT_SAVED_YET') {
      downloadSignature(results[i].getAttribute('id'), 5);
    } else {
      errorCallback(null, 'Ha ocurrido un error inesperado');
    }
  }
}

function downloadSignature(id, retries) {
  var xhr = new XMLHttpRequest();
  xhr.open('GET', scBaseAddress + '/clientsigner/RetrieveService?op=get&v=1_0&id=' + id, true);
  xhr.onreadystatechange = function () {
    if (xhr.readyState !== 4 || xhr.status !== 200) return;
    var text = xhr.responseText;
    if (text.substr(0, 6).toLowerCase() === 'err-06' && retries > 0) {
      setTimeout(function () {
        downloadSignature(id, retries - 1);
      }, 1000);
      return;
    }
    if (text.substr(0, 4).toLowerCase() === 'err-') {
      errorCallback(null, 'Ha ocurrido un error inesperado');
      return;
    }
    var separator = text.indexOf('|');
    var certificate = text.substring(0, separator).replace(/-/g, '+').replace(/_/g, '/');
    var signature = text
      .substring(separator + 1)
      .replace(/-/g, '+')
      .replace(/_/g, '/');
    successCallback(signature, certificate, id);
  };
  xhr.onerror = function (e) {
    errorCallback(e, 'Ha ocurrido un error inesperado');
  };
  xhr.send();
}

function successCallback(signature, certificate, transactionId) {
  result[result.length] = { signature: signature, transactionId: transactionId || '' };
  if (result.length === config.length) {
    result[config.length] = { certificate: certificate };
    clientSignerAfirma5.callback(JSON.stringify(result));
  }
}

function errorCallback(e, message) {
  if (clientSignerAfirma5.errorCallback !== null) clientSignerAfirma5.errorCallback(message);
  else alert('Ha ocurrido un error al firmar: ' + message);
}

function sign_complete(signResult) {
  var form = document.getElementById(clientSignerAfirma5.form);
  form.clientSignerResult.value = signResult;
  form.submit();
}

function generateUUID() {
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, function (c) {
    var r = (Math.random() * 16) | 0;
    return (c === 'x' ? r : (r & 3) | 8).toString(16);
  });
}

function getBaseAddress(base) {
  if (base.indexOf('./') === 0 || base.indexOf('http') === 0) return base;
  if (base.indexOf('/') === 0) return window.location.protocol + '//' + window.location.host + base;
  return window.location.protocol + '//' + window.location.host + '/' + base;
}

function getJSessionId() {
  var match = document.cookie.match(/JSESSIONID=[^;]+/);
  return match ? match[0].substring(11) : null;
}
