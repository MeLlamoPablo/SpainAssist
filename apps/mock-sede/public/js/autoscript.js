/*
 * autoscript.js for the SpainAssist mock sede.
 *
 * An imitation (not the original code) of the public shape of AutoFirma's JavaScript client,
 * autoscript.js 1.9.0 (github.com/ctt-gob-es/clienteafirma): the same classic-script globals
 * (AutoScript, MiniApplet, Base64, Cipher, SupportDialog), the same public methods and constants,
 * and the same behaviour when AutoFirma is not installed:
 *   - desktop (default): launches afirma://websocket?ports=P1,P2,P3&v=4&jvc=4&idsession=ID, then
 *     tries wss://127.0.0.1:P (protocol v4: "echo=-idsession=ID@EOF" -> "OK", then the operation
 *     URL afirma://sign?op=sign&...) and, after the retries, calls the error callback with
 *     ("es.gob.afirma.standalone.ApplicationNotFoundException", "No se ha podido conectar con AutoFirma.");
 *   - setForceWSMode(true): "intermediate server" mode, launches afirma://sign?... and polls the
 *     RetrieveService given to setServlets() (results are not encrypted in this imitation).
 * The three timing constants below are rewritten by the mock server (see src/assets.ts).
 */
// biome-ignore-all lint/suspicious/noVar: autoscript.js declares classic-script globals with var.
// biome-ignore-all lint/suspicious/noShadowRestrictedNames: faithful "function (window, undefined)" wrapper.
// biome-ignore-all lint/correctness/noUnusedVariables: these globals are the script's public API.
// biome-ignore-all lint/correctness/noUnusedFunctionParameters: public methods keep the official signatures.
// biome-ignore-all lint/complexity/useArrowFunction: faithful "(function (window, undefined) {...})(window)" declaration.

var originalXMLHttpRequest = window.XMLHttpRequest;

var SupportDialog = (() => {
  var enabled = true;
  return {
    enableSupportDialog: (enable) => {
      enabled = enable !== false;
    },
    isSupportDialogEnabled: () => enabled,
  };
})();

var Base64 = {
  encode: (input, URL_SAFE) => {
    const bytes = new TextEncoder().encode(input == null ? '' : String(input));
    return Base64.encodeByteArray(bytes, URL_SAFE);
  },
  decode: (input, URL_SAFE) => new TextDecoder().decode(Base64.decodeToByteArray(input, URL_SAFE)),
  encodeByteArray: (bytes, URL_SAFE) => {
    let binary = '';
    for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]);
    const b64 = btoa(binary);
    return URL_SAFE ? b64.replace(/\+/g, '-').replace(/\//g, '_') : b64;
  },
  encodeArrayBuffer: (buffer, URL_SAFE) => Base64.encodeByteArray(new Uint8Array(buffer), URL_SAFE),
  decodeToByteArray: (input, URL_SAFE) => {
    let b64 = String(input || '').replace(/\s+/g, '');
    if (URL_SAFE !== false) b64 = b64.replace(/-/g, '+').replace(/_/g, '/');
    const binary = atob(b64);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
    return bytes;
  },
};

var Cipher = {
  des: () => {
    throw new Error('Cifrado DES no disponible en esta imitación de autoscript.js');
  },
};

var AutoScript = (function (window, undefined) {
  var VERSION = '1.9.0';

  var CHECKTIME_NO = 'CT_NO';
  var CHECKTIME_RECOMMENDED = 'CT_RECOMMENDED';
  var CHECKTIME_OBLIGATORY = 'CT_OBLIGATORY';

  var KEYSTORE_WINDOWS = 'WINDOWS';
  var KEYSTORE_APPLE = 'APPLE';
  var KEYSTORE_PKCS12 = 'PKCS12';
  var KEYSTORE_PKCS11 = 'PKCS11';
  var KEYSTORE_MOZILLA = 'MOZ_UNI';
  var KEYSTORE_SHARED_NSS = 'SHARED_NSS';
  var KEYSTORE_JAVA = 'JAVA';
  var KEYSTORE_JCEKS = 'JCEKS';
  var KEYSTORE_JAVACE = 'JAVACE';
  var KEYSTORE_DNIE = 'DNIEJAVA';

  var AUTOFIRMA_LAUNCHING_TIME = 2000; // mock-sede:launching-time
  var AUTOFIRMA_CONNECTION_RETRIES = 15; // mock-sede:retries
  var RETRY_INTERVAL = 2000; // mock-sede:retry-interval

  var JAVA_ARGUMENTS = null;
  var SYSTEM_PROPERTIES = null;

  var ERROR_NOT_FOUND = 'es.gob.afirma.standalone.ApplicationNotFoundException';
  var MSG_NOT_FOUND = 'No se ha podido conectar con AutoFirma.';

  var clienteFirma = null;
  var defaultKeyStore = null;
  var forceWSMode = false;
  var storageServletAddress = null;
  var retrieverServletAddress = null;
  var portRange = [49152, 65535];
  var stickySignatory = false;
  var locale = null;
  var minimumClientVersion = null;
  var appName = null;
  var checkTimeFailed = false;

  var errorMessage = '';
  var errorType = '';

  var currentBatch = null;
  var localBatchProcess = false;

  // --- helpers ------------------------------------------------------------------------------

  function generateNewIdSession() {
    const chars = '0123456789abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ';
    let id = '';
    for (let i = 0; i < 20; i++) id += chars.charAt(Math.floor(Math.random() * chars.length));
    return id;
  }

  function toUrlSafe(b64) {
    return String(b64).replace(/\+/g, '-').replace(/\//g, '_');
  }

  function fromUrlSafe(b64) {
    return String(b64).replace(/-/g, '+').replace(/_/g, '/');
  }

  function textToUrlSafeB64(text) {
    return Base64.encode(text, true);
  }

  function isFirefox() {
    return navigator.userAgent.toUpperCase().indexOf('FIREFOX') !== -1;
  }

  function isAndroid() {
    return navigator.userAgent.toUpperCase().indexOf('ANDROID') !== -1;
  }

  function isIOS() {
    return /IPAD|IPHONE|IPOD/.test(navigator.userAgent.toUpperCase());
  }

  function openUrlWithJavaScript(url) {
    window.location.href = url;
  }

  function openUrlWithIframe(url) {
    const iframe = document.createElement('iframe');
    iframe.style.display = 'none';
    iframe.src = url;
    document.body.appendChild(iframe);
  }

  /** Hands an afirma:// URL to the operating system (it starts AutoFirma when installed). */
  function openUrl(url) {
    if (isFirefox()) openUrlWithIframe(url);
    else openUrlWithJavaScript(url);
  }

  function choosePorts() {
    const ports = [];
    while (ports.length < 3) {
      const p = portRange[0] + Math.floor(Math.random() * (portRange[1] - portRange[0] + 1));
      if (ports.indexOf(p) === -1) ports.push(p);
    }
    return ports;
  }

  function setError(type, message) {
    errorType = type;
    errorMessage = message;
  }

  /** Builds the parameters of an operation URL (common to both transports). */
  function operationQuery(op, p, keystore) {
    const q = [];
    if (minimumClientVersion) q.push(`mcv=${minimumClientVersion}`);
    q.push(`op=${op}`);
    if (p.cop) q.push(`cop=${p.cop}`);
    if (p.algorithm) q.push(`algorithm=${p.algorithm}`);
    if (p.format) q.push(`format=${p.format}`);
    if (p.params) q.push(`properties=${textToUrlSafeB64(p.params)}`);
    if (keystore) q.push(`ksb64=${textToUrlSafeB64(keystore)}`);
    q.push(`sticky=${stickySignatory}`);
    if (appName) q.push(`appname=${appName}`);
    if (locale) q.push(`locale=${locale}`);
    if (p.extra) for (const k in p.extra) q.push(`${k}=${p.extra[k]}`);
    if (p.data) q.push(`dat=${toUrlSafe(p.data)}`);
    return q;
  }

  /** Parses AutoFirma's answer and calls the right callback. */
  function processResult(op, data, successCallback, errorCallback) {
    if (data === 'CANCEL' || data === 'CANCELLED') {
      setError(
        'es.gob.afirma.core.AOCancelledOperationException',
        'Operacion cancelada por el usuario',
      );
      if (errorCallback) errorCallback(errorType, errorMessage);
      return;
    }
    if (data === 'MEMORY_ERROR') {
      setError(
        'es.gob.afirma.core.OutOfMemoryError',
        'Memoria insuficiente para completar la operacion',
      );
      if (errorCallback) errorCallback(errorType, errorMessage);
      return;
    }
    if (data === 'NULL' || data.indexOf('err-') === 0 || data.indexOf('SAF_') === 0) {
      const sep = data.indexOf(':=');
      setError(
        'es.gob.afirma.core.AOException',
        sep !== -1 ? data.substring(sep + 2).trim() : data,
      );
      if (errorCallback) errorCallback(errorType, errorMessage);
      return;
    }
    if (!successCallback) return;
    if (op === 'save') {
      successCallback(data);
      return;
    }
    if (op === 'selectcert') {
      successCallback(fromUrlSafe(data));
      return;
    }
    if (op === 'load') {
      const names = [];
      const contents = [];
      const items = data.split('|');
      for (let i = 0; i < items.length; i++) {
        const colon = items[i].lastIndexOf(':');
        names.push(items[i].substring(0, colon));
        contents.push(fromUrlSafe(items[i].substring(colon + 1)));
      }
      if (names.length === 1) successCallback(names[0], contents[0]);
      else successCallback(names, contents);
      return;
    }
    const parts = data.split('|');
    if (op === 'batch') {
      successCallback(
        Base64.decode(parts[0], true),
        parts.length > 1 ? fromUrlSafe(parts[1]) : null,
      );
      return;
    }
    // sign / cosign / countersign / signandsave: "certificate|signature[|extraData]"
    const certificateB64 = fromUrlSafe(parts[0]);
    const signatureB64 = parts.length > 1 ? fromUrlSafe(parts[1]) : null;
    const extraData = parts.length > 2 ? Base64.decode(parts[2], true) : undefined;
    successCallback(signatureB64, certificateB64, extraData);
  }

  // --- WebSocket client (desktop) -------------------------------------------------------------

  function AppAfirmaWebSocketClient() {
    let idSession = null;
    let ports = [];
    let ws = null;
    let connected = false;
    let keystore = defaultKeyStore;
    let currentOp = null;
    let successCb = null;
    let errorCb = null;

    function reportError(type, message) {
      setError(type, message);
      if (ws) {
        try {
          ws.close();
        } catch (_e) {
          // ignored
        }
      }
      ws = null;
      connected = false;
      if (errorCb) errorCb(type, message);
    }

    function onMessage(event) {
      const data = String(event.data);
      if (data === '#wait') {
        setTimeout(() => {
          if (ws) ws.send(`afirma://getresult?idsession=${idSession}`);
        }, RETRY_INTERVAL);
        return;
      }
      processResult(currentOp, data, successCb, errorCb);
    }

    function tryConnect(attempt, operationUrl) {
      if (attempt >= AUTOFIRMA_CONNECTION_RETRIES) {
        reportError(ERROR_NOT_FOUND, MSG_NOT_FOUND);
        return;
      }
      let portIndex = 0;
      function nextPort() {
        if (connected) return;
        if (portIndex >= ports.length) {
          setTimeout(() => {
            tryConnect(attempt + 1, operationUrl);
          }, RETRY_INTERVAL);
          return;
        }
        const port = ports[portIndex++];
        let finished = false;
        let socket;
        function giveUp() {
          if (finished) return;
          finished = true;
          try {
            socket.close();
          } catch (_e) {
            // ignored
          }
          nextPort();
        }
        try {
          socket = new WebSocket(`wss://127.0.0.1:${port}`);
        } catch (_e) {
          finished = true;
          nextPort();
          return;
        }
        socket.onopen = () => {
          socket.send(`echo=-idsession=${idSession}@EOF`);
        };
        socket.onmessage = (event) => {
          if (finished) return;
          if (String(event.data) === 'OK') {
            finished = true;
            connected = true;
            ws = socket;
            socket.onmessage = onMessage;
            socket.onclose = () => {
              connected = false;
              ws = null;
            };
            socket.send(operationUrl);
          } else {
            giveUp();
          }
        };
        socket.onerror = giveUp;
        socket.onclose = giveUp;
      }
      nextPort();
    }

    function execute(op, p, successCallback, errorCallback) {
      // Like the official client, a new operation replaces the callbacks of a pending one.
      currentOp = op;
      successCb = successCallback;
      errorCb = errorCallback;
      if (!connected) idSession = generateNewIdSession();
      const url = `afirma://${op}?${operationQuery(op, p, keystore).join('&')}&idsession=${idSession}`;
      if (connected && ws) {
        ws.send(url);
        return;
      }
      ports = choosePorts();
      openUrl(`afirma://websocket?ports=${ports.join(',')}&v=4&jvc=4&idsession=${idSession}`);
      setTimeout(() => {
        tryConnect(0, url);
      }, AUTOFIRMA_LAUNCHING_TIME);
    }

    this.setKeyStore = (ks) => {
      keystore = ks;
    };
    this.sign = (dataB64, algorithm, format, params, ok, ko) => {
      execute(
        'sign',
        { data: dataB64, algorithm: algorithm, format: format, params: params },
        ok,
        ko,
      );
    };
    this.cosign = (signB64, algorithm, format, params, ok, ko) => {
      execute(
        'cosign',
        { data: signB64, algorithm: algorithm, format: format, params: params },
        ok,
        ko,
      );
    };
    this.counterSign = (signB64, algorithm, format, params, ok, ko) => {
      execute(
        'countersign',
        { data: signB64, algorithm: algorithm, format: format, params: params },
        ok,
        ko,
      );
    };
    this.signAndSaveToFile = (
      operationId,
      dataB64,
      algorithm,
      format,
      params,
      fileName,
      ok,
      ko,
    ) => {
      execute(
        'signandsave',
        {
          cop: operationId,
          data: dataB64,
          algorithm: algorithm,
          format: format,
          params: params,
          extra: fileName ? { filename: encodeURIComponent(fileName) } : null,
        },
        ok,
        ko,
      );
    };
    this.selectCertificate = (params, ok, ko) => {
      execute('selectcert', { params: params }, ok, ko);
    };
    this.signBatch = (batchB64, preUrl, postUrl, params, ok, ko, json) => {
      const extra = {
        batchpresignerurl: encodeURIComponent(preUrl),
        batchpostsignerurl: encodeURIComponent(postUrl),
        needcert: 'true',
      };
      if (json) extra.jsonbatch = 'true';
      if (localBatchProcess) extra.localBatchProcess = 'true';
      execute('batch', { data: batchB64, params: params, extra: extra }, ok, ko);
    };
    this.saveDataToFile = (dataB64, title, fileName, extension, description, ok, ko) => {
      execute(
        'save',
        {
          data: dataB64,
          extra: {
            title: encodeURIComponent(title || ''),
            filename: encodeURIComponent(fileName || ''),
            extension: encodeURIComponent(extension || ''),
            description: encodeURIComponent(description || ''),
          },
        },
        ok,
        ko,
      );
    };
    this.getFileNameContentBase64 = (title, extensions, description, filePath, ok, ko, multi) => {
      execute(
        'load',
        {
          extra: {
            title: encodeURIComponent(title || ''),
            exts: encodeURIComponent(extensions || ''),
            desc: encodeURIComponent(description || ''),
            filepath: encodeURIComponent(filePath || ''),
            multiload: multi ? 'true' : 'false',
          },
        },
        ok,
        ko,
      );
    };
  }

  // --- Intermediate server client (setForceWSMode(true), mobile) ---------------------------------

  function AppAfirmaJSIntermediateServer() {
    let keystore = defaultKeyStore;

    function execute(op, p, successCallback, errorCallback) {
      if (!storageServletAddress || !retrieverServletAddress) {
        setError(
          'java.lang.IllegalArgumentException',
          'No se han indicado las direcciones de los servicios de almacenamiento y recuperacion',
        );
        if (errorCallback) errorCallback(errorType, errorMessage);
        return;
      }
      const id = generateNewIdSession();
      const url =
        `afirma://${op}?ver=4&${operationQuery(op, p, keystore).join('&')}&id=${id}` +
        `&stservlet=${encodeURIComponent(storageServletAddress)}` +
        `&rtservlet=${encodeURIComponent(retrieverServletAddress)}`;
      openUrl(url);
      function poll(attempt) {
        if (attempt >= AUTOFIRMA_CONNECTION_RETRIES) {
          setError(ERROR_NOT_FOUND, MSG_NOT_FOUND);
          if (errorCallback) errorCallback(errorType, errorMessage);
          return;
        }
        const xhr = new originalXMLHttpRequest();
        xhr.open('GET', `${retrieverServletAddress}?op=get&v=1_0&id=${id}&it=${attempt}`, true);
        xhr.onload = () => {
          const text = String(xhr.responseText || '').trim();
          if (xhr.status !== 200 || text.indexOf('err-06') === 0 || text === '') {
            setTimeout(() => {
              poll(attempt + 1);
            }, RETRY_INTERVAL);
          } else if (text === '#wait') {
            setTimeout(() => {
              poll(0);
            }, RETRY_INTERVAL);
          } else {
            processResult(op, text, successCallback, errorCallback);
          }
        };
        xhr.onerror = () => {
          setTimeout(() => {
            poll(attempt + 1);
          }, RETRY_INTERVAL);
        };
        xhr.send();
      }
      setTimeout(() => {
        poll(0);
      }, AUTOFIRMA_LAUNCHING_TIME);
    }

    function probe(servletUrl) {
      const xhr = new originalXMLHttpRequest();
      xhr.open('GET', `${servletUrl}?op=check`, true);
      xhr.send();
    }

    this.setKeyStore = (ks) => {
      keystore = ks;
    };
    this.setServlets = (storage, retriever) => {
      probe(storage);
      probe(retriever);
    };
    this.sign = (dataB64, algorithm, format, params, ok, ko) => {
      execute(
        'sign',
        { data: dataB64, algorithm: algorithm, format: format, params: params },
        ok,
        ko,
      );
    };
    this.cosign = (signB64, algorithm, format, params, ok, ko) => {
      execute(
        'cosign',
        { data: signB64, algorithm: algorithm, format: format, params: params },
        ok,
        ko,
      );
    };
    this.counterSign = (signB64, algorithm, format, params, ok, ko) => {
      execute(
        'countersign',
        { data: signB64, algorithm: algorithm, format: format, params: params },
        ok,
        ko,
      );
    };
    this.signAndSaveToFile = (
      operationId,
      dataB64,
      algorithm,
      format,
      params,
      fileName,
      ok,
      ko,
    ) => {
      execute(
        'signandsave',
        {
          cop: operationId,
          data: dataB64,
          algorithm: algorithm,
          format: format,
          params: params,
          extra: fileName ? { filename: encodeURIComponent(fileName) } : null,
        },
        ok,
        ko,
      );
    };
    this.selectCertificate = (params, ok, ko) => {
      execute('selectcert', { params: params }, ok, ko);
    };
    this.signBatch = (batchB64, preUrl, postUrl, params, ok, ko, json) => {
      const extra = {
        batchpresignerurl: encodeURIComponent(preUrl),
        batchpostsignerurl: encodeURIComponent(postUrl),
        needcert: 'true',
      };
      if (json) extra.jsonbatch = 'true';
      execute('batch', { data: batchB64, params: params, extra: extra }, ok, ko);
    };
    this.saveDataToFile = (dataB64, title, fileName, extension, description, ok, ko) => {
      execute(
        'save',
        { data: dataB64, extra: { filename: encodeURIComponent(fileName || '') } },
        ok,
        ko,
      );
    };
    this.getFileNameContentBase64 = (title, extensions, description, filePath, ok, ko, multi) => {
      execute('load', { extra: { multiload: multi ? 'true' : 'false' } }, ok, ko);
    };
  }

  // --- public API -------------------------------------------------------------------------------

  function cargarAppAfirma(clientAddress, keystore) {
    if (checkTimeFailed) return;
    if (keystore !== undefined && keystore !== null) defaultKeyStore = keystore;
    if (forceWSMode || isAndroid() || isIOS()) {
      clienteFirma = new AppAfirmaJSIntermediateServer();
      if (storageServletAddress && retrieverServletAddress) {
        clienteFirma.setServlets(storageServletAddress, retrieverServletAddress);
      }
    } else {
      clienteFirma = new AppAfirmaWebSocketClient();
    }
  }

  function sign(dataB64, algorithm, format, params, successCallback, errorCallback) {
    clienteFirma.sign(dataB64, algorithm, format, params, successCallback, errorCallback);
  }

  function coSign(signB64, dataB64, algorithm, format, params, successCallback, errorCallback) {
    // dataB64 is ignored, as in the official client.
    clienteFirma.cosign(signB64, algorithm, format, params, successCallback, errorCallback);
  }

  function cosign(signB64, algorithm, format, params, successCallback, errorCallback) {
    clienteFirma.cosign(signB64, algorithm, format, params, successCallback, errorCallback);
  }

  function counterSign(signB64, algorithm, format, params, successCallback, errorCallback) {
    clienteFirma.counterSign(signB64, algorithm, format, params, successCallback, errorCallback);
  }

  function signAndSaveToFile(
    operationId,
    dataB64,
    algorithm,
    format,
    params,
    outputFileName,
    successCallback,
    errorCallback,
  ) {
    clienteFirma.signAndSaveToFile(
      operationId,
      dataB64,
      algorithm,
      format,
      params,
      outputFileName,
      successCallback,
      errorCallback,
    );
  }

  function selectCertificate(params, successCallback, errorCallback) {
    clienteFirma.selectCertificate(params, successCallback, errorCallback);
  }

  function createBatch(algorithm, format, suboperation, extraparams) {
    currentBatch = {
      algorithm: algorithm,
      format: format,
      suboperation: suboperation,
      extraparams: extraparams ? Base64.encode(extraparams) : null,
      singlesigns: [],
    };
  }

  function addDocumentToBatch(id, datareference, format, suboperation, extraparams) {
    if (currentBatch === null) {
      throw new Error('Es obligatorio crear un lote antes de agregarle documentos');
    }
    if (id === undefined || id === null || id === '') {
      throw new Error('Es obligatorio asignar un identificador a los documentos del lote');
    }
    for (let i = 0; i < currentBatch.singlesigns.length; i++) {
      if (currentBatch.singlesigns[i].id === id) {
        throw new Error(`El identificador ${id} ya existe en el lote`);
      }
    }
    const single = { id: id, datareference: datareference };
    if (format) single.format = format;
    if (suboperation) single.suboperation = suboperation;
    if (extraparams) single.extraparams = Base64.encode(extraparams);
    currentBatch.singlesigns.push(single);
  }

  function setLocalBatchProcess(isLocalBatchProcess) {
    localBatchProcess = isLocalBatchProcess === true;
  }

  function signBatchProcess(
    stopOnError,
    batchPreSignerUrl,
    batchPostSignerUrl,
    certFilters,
    successCallback,
    errorCallback,
  ) {
    if (currentBatch === null) {
      throw new Error('Es obligatorio crear un lote antes de firmarlo');
    }
    currentBatch.stoponerror = stopOnError === true;
    const batchB64 = Base64.encode(JSON.stringify(currentBatch), true);
    clienteFirma.signBatch(
      batchB64,
      batchPreSignerUrl,
      batchPostSignerUrl,
      certFilters,
      successCallback,
      errorCallback,
      true,
    );
  }

  function signBatch(
    batchB64,
    batchPreSignerUrl,
    batchPostSignerUrl,
    params,
    successCallback,
    errorCallback,
  ) {
    clienteFirma.signBatch(
      batchB64,
      batchPreSignerUrl,
      batchPostSignerUrl,
      params,
      successCallback,
      errorCallback,
      false,
    );
  }

  function saveDataToFile(
    dataB64,
    title,
    fileName,
    extension,
    description,
    successCallback,
    errorCallback,
  ) {
    clienteFirma.saveDataToFile(
      dataB64,
      title,
      fileName,
      extension,
      description,
      successCallback,
      errorCallback,
    );
  }

  function getFileNameContentBase64(
    title,
    extensions,
    description,
    filePath,
    successCallback,
    errorCallback,
  ) {
    clienteFirma.getFileNameContentBase64(
      title,
      extensions,
      description,
      filePath,
      successCallback,
      errorCallback,
      false,
    );
  }

  function getMultiFileNameContentBase64(
    title,
    extensions,
    description,
    filePath,
    successCallback,
    errorCallback,
  ) {
    clienteFirma.getFileNameContentBase64(
      title,
      extensions,
      description,
      filePath,
      successCallback,
      errorCallback,
      true,
    );
  }

  function getCurrentLog(successCallback, errorCallback) {
    setError('java.lang.UnsupportedOperationException', 'La consulta del log no esta soportada');
    if (errorCallback) errorCallback(errorType, errorMessage);
  }

  function checkTime(checkType, maxMillis, checkURL) {
    if (!checkType || checkType === CHECKTIME_NO || !maxMillis || maxMillis <= 0) return;
    const xhr = new originalXMLHttpRequest();
    try {
      xhr.open('GET', checkURL || `${document.URL}/${Math.random()}`, false);
      xhr.send();
    } catch (_e) {
      return;
    }
    const serverDate = xhr.getResponseHeader('Date');
    if (!serverDate) return;
    const diff = Math.abs(new Date(serverDate).getTime() - Date.now());
    if (diff > maxMillis) {
      if (checkType === CHECKTIME_OBLIGATORY) {
        checkTimeFailed = true;
        alert(
          'La hora de su equipo no es correcta. Corrijala y vuelva a cargar la pagina para poder firmar.',
        );
      } else if (checkType === CHECKTIME_RECOMMENDED) {
        alert(
          'La hora de su equipo no coincide con la del servidor. Puede tener problemas al firmar.',
        );
      }
    }
  }

  function setKeyStore(ksType) {
    // Like the official client, this fails if cargarAppAfirma() has not been called yet.
    clienteFirma.setKeyStore(ksType);
  }

  function setForceWSMode(force) {
    forceWSMode = force === true;
  }

  function setServlets(storageServlet, retrieverServlet) {
    storageServletAddress = storageServlet;
    retrieverServletAddress = retrieverServlet;
    if (clienteFirma?.setServlets) clienteFirma.setServlets(storageServlet, retrieverServlet);
  }

  function setPortRange(minPort, maxPort) {
    if (minPort > 0 && maxPort >= minPort) portRange = [minPort, maxPort];
  }

  function setStickySignatory(sticky) {
    stickySignatory = sticky === true;
  }

  function setLocale(newLocale) {
    locale = newLocale;
  }

  function setMinimumClientVersion(version) {
    minimumClientVersion = version;
  }

  function setAppName(name) {
    appName = name;
  }

  function getErrorMessage() {
    return errorMessage;
  }

  function getErrorType() {
    return errorType;
  }

  function getBase64FromText(plainText, charset) {
    return Base64.encode(String(plainText).replace(/\r\n/g, '\n'));
  }

  function getTextFromBase64(dataB64, charset) {
    return Base64.decode(dataB64);
  }

  function downloadRemoteData(url, successFunction, errorFunction) {
    const xhr = new originalXMLHttpRequest();
    xhr.open('GET', url, true);
    xhr.responseType = 'arraybuffer';
    xhr.onload = () => {
      if (xhr.status === 200) successFunction(Base64.encodeArrayBuffer(xhr.response));
      else if (errorFunction) errorFunction(new Error(`HTTP ${xhr.status}`));
    };
    xhr.onerror = (e) => {
      if (errorFunction) errorFunction(e);
    };
    xhr.send();
  }

  function echo() {
    return 'Cliente JavaScript';
  }

  function needNativeAppInstalled() {
    return true;
  }

  function isJNLP() {
    return false;
  }

  function setForceAFirma(force) {}

  function setJnlpService(jnlpServiceAddress) {}

  return {
    VERSION: VERSION,
    CHECKTIME_NO: CHECKTIME_NO,
    CHECKTIME_RECOMMENDED: CHECKTIME_RECOMMENDED,
    CHECKTIME_OBLIGATORY: CHECKTIME_OBLIGATORY,
    KEYSTORE_WINDOWS: KEYSTORE_WINDOWS,
    KEYSTORE_APPLE: KEYSTORE_APPLE,
    KEYSTORE_PKCS12: KEYSTORE_PKCS12,
    KEYSTORE_PKCS11: KEYSTORE_PKCS11,
    KEYSTORE_MOZILLA: KEYSTORE_MOZILLA,
    KEYSTORE_SHARED_NSS: KEYSTORE_SHARED_NSS,
    KEYSTORE_JAVA: KEYSTORE_JAVA,
    KEYSTORE_JCEKS: KEYSTORE_JCEKS,
    KEYSTORE_JAVACE: KEYSTORE_JAVACE,
    KEYSTORE_DNIE: KEYSTORE_DNIE,
    AUTOFIRMA_LAUNCHING_TIME: AUTOFIRMA_LAUNCHING_TIME,
    AUTOFIRMA_CONNECTION_RETRIES: AUTOFIRMA_CONNECTION_RETRIES,
    JAVA_ARGUMENTS: JAVA_ARGUMENTS,
    SYSTEM_PROPERTIES: SYSTEM_PROPERTIES,
    echo: echo,
    checkTime: checkTime,
    cargarAppAfirma: cargarAppAfirma,
    cargarMiniApplet: cargarAppAfirma,
    sign: sign,
    coSign: coSign,
    cosign: cosign,
    counterSign: counterSign,
    signAndSaveToFile: signAndSaveToFile,
    selectCertificate: selectCertificate,
    createBatch: createBatch,
    addDocumentToBatch: addDocumentToBatch,
    setLocalBatchProcess: setLocalBatchProcess,
    signBatchProcess: signBatchProcess,
    signBatch: signBatch,
    saveDataToFile: saveDataToFile,
    getFileNameContentBase64: getFileNameContentBase64,
    getMultiFileNameContentBase64: getMultiFileNameContentBase64,
    getCurrentLog: getCurrentLog,
    downloadRemoteData: downloadRemoteData,
    getBase64FromText: getBase64FromText,
    getTextFromBase64: getTextFromBase64,
    getErrorMessage: getErrorMessage,
    getErrorType: getErrorType,
    isAndroid: isAndroid,
    isIOS: isIOS,
    needNativeAppInstalled: needNativeAppInstalled,
    isJNLP: isJNLP,
    setForceAFirma: setForceAFirma,
    setForceWSMode: setForceWSMode,
    setJnlpService: setJnlpService,
    setKeyStore: setKeyStore,
    setLocale: setLocale,
    setMinimumClientVersion: setMinimumClientVersion,
    setPortRange: setPortRange,
    setServlets: setServlets,
    setStickySignatory: setStickySignatory,
    setAppName: setAppName,
  };
})(window, undefined);

/* Legacy alias kept "por compatibilidad" by the official script. */
var MiniApplet = AutoScript;
