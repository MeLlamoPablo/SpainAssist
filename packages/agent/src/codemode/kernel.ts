/**
 * The codemode kernel: plain JavaScript evaluated in every workflow's QuickJS context before the
 * workflow module. It builds `api` and the `@spainassist/ui` module, keeps durable state, renders
 * interfaces with a small hooks runtime and dispatches the user's events.
 *
 * Host functions (removed from globalThis before user code runs):
 *   __hostCall(op, argsJson) -> Promise<resultJson>  rejects with an Error whose message is JSON
 *                                                    {code, message, op, effect, retryable}
 *   __hostEmit(kind, json)                           sync notification (render, durable)
 *   __hostLog(line)
 *   __boot                                           JSON: {workflowId, procedures, state}
 *
 * Exposed back to the host: __sa_dispatch(key, handlerId, rev, valueJson) and
 * __sa_main(moduleFactory) (the host grabs them, then deletes the globals).
 *
 * Determinism: state is keyed by explicit names (memo keys, UI keys, durable names), never by
 * call order, so `Promise.all` and races replay correctly. Memoized values are JSON round-tripped
 * on the first run too, so a first run and a replay see identical values.
 *
 * Written without template literals: this file is itself a template string (whose only
 * substitution is the handler of UI_FAILED).
 */
import { UI_FAILED } from '@sa/shared';

export const KERNEL = String.raw`
'use strict';
(function () {
  var g = globalThis;
  var host = { call: g.__hostCall, emit: g.__hostEmit, log: g.__hostLog };
  var boot = JSON.parse(g.__boot);
  delete g.__hostCall; delete g.__hostEmit; delete g.__hostLog; delete g.__boot;

  var KEY_RE = /^[A-Za-z0-9][A-Za-z0-9_.:\-]{0,99}$/;

  // ------------------------------------------------------------------------------------------
  // Errors and JSON
  // ------------------------------------------------------------------------------------------

  class CodemodeError extends Error {
    constructor(info) {
      super(info && info.message ? info.message : 'Error');
      this.name = 'CodemodeError';
      this.code = (info && info.code) || 'internal';
      if (info && info.op) this.op = info.op;
      this.effect = (info && info.effect) || 'unknown';
      this.retryable = !!(info && info.retryable);
      if (info && info.details !== undefined) this.details = info.details;
    }
    toJSON() {
      return { name: this.name, code: this.code, message: this.message, op: this.op, effect: this.effect };
    }
  }

  function fromHostError(error, op) {
    var info;
    try { info = JSON.parse(error && error.message); } catch (_) { info = null; }
    if (!info || typeof info !== 'object') info = { code: 'internal', message: String(error && error.message || error) };
    if (!info.op) info.op = op;
    return new CodemodeError(info);
  }

  function describe(value) {
    if (value === null) return 'null';
    if (typeof value === 'function') return 'a function';
    if (typeof value === 'symbol') return 'a symbol';
    if (typeof value === 'bigint') return 'a bigint';
    if (Array.isArray(value)) return 'an array';
    return typeof value;
  }

  /** JSON text of a value, refusing what would not survive a restart. */
  function toJson(value, what) {
    var seen = [];
    var text = JSON.stringify(value === undefined ? null : value, function (k, v) {
      if (typeof v === 'function' || typeof v === 'symbol' || typeof v === 'bigint')
        throw new TypeError(what + ' must be JSON-serializable (found ' + describe(v) + (k ? ' at "' + k + '"' : '') + ').');
      if (v && typeof v === 'object') {
        if (seen.indexOf(v) !== -1) throw new TypeError(what + ' must not contain cycles.');
        seen.push(v);
      }
      return v;
    });
    return text;
  }

  function clone(value) {
    return value === undefined ? undefined : JSON.parse(JSON.stringify(value));
  }

  function checkKey(key, what) {
    if (typeof key !== 'string' || !KEY_RE.test(key))
      throw new TypeError(what + ' must be a string of letters, digits and _.:- (max 100), got ' + JSON.stringify(key) + '.');
  }

  function call(op, args) {
    var json = args === undefined ? '{}' : toJson(args, op + ' arguments');
    return host.call(op, json).then(
      function (text) { return text === '' || text === undefined ? undefined : JSON.parse(text); },
      function (error) { throw fromHostError(error, op); }
    );
  }

  function emit(kind, payload) {
    host.emit(kind, JSON.stringify(payload));
  }

  // ------------------------------------------------------------------------------------------
  // console
  // ------------------------------------------------------------------------------------------

  function format(args) {
    var parts = [];
    for (var i = 0; i < args.length; i++) {
      var a = args[i];
      if (typeof a === 'string') parts.push(a);
      else if (a instanceof Error) parts.push(a.name + ': ' + a.message);
      else {
        try { parts.push(JSON.stringify(a)); } catch (_) { parts.push(String(a)); }
      }
    }
    return parts.join(' ');
  }
  g.console = {
    log: function () { host.log(format(arguments)); },
    info: function () { host.log(format(arguments)); },
    warn: function () { host.log('[warn] ' + format(arguments)); },
    error: function () { host.log('[error] ' + format(arguments)); },
    debug: function () {},
  };

  // ------------------------------------------------------------------------------------------
  // Durable state: api.state
  // ------------------------------------------------------------------------------------------

  var memo = new Map();
  var stateIn = boot.state || {};
  Object.keys(stateIn.memo || {}).forEach(function (key) { memo.set(key, stateIn.memo[key]); });
  var inflight = new Map();

  var state = {
    memo: function (key, fn) {
      checkKey(key, 'state.memo key');
      if (typeof fn !== 'function') throw new TypeError('state.memo("' + key + '", fn): fn must be a function.');
      if (memo.has(key)) return Promise.resolve(clone(memo.get(key).value));
      if (inflight.has(key)) return inflight.get(key);
      var promise = Promise.resolve().then(fn).then(function (value) {
        var json = toJson(value, 'The value of state.memo("' + key + '")');
        var stored = JSON.parse(json);
        return call('state.set', { key: key, value: stored }).then(function () {
          memo.set(key, { value: stored });
          return clone(stored);
        });
      });
      inflight.set(key, promise);
      var clear = function () { inflight.delete(key); };
      promise.then(clear, clear);
      return promise;
    },
    get: function (key) {
      checkKey(key, 'state.get key');
      return memo.has(key) ? clone(memo.get(key).value) : undefined;
    },
    has: function (key) {
      checkKey(key, 'state.has key');
      return memo.has(key);
    },
    set: function (key, value) {
      checkKey(key, 'state.set key');
      var stored = JSON.parse(toJson(value, 'The value of state.set("' + key + '")'));
      return call('state.set', { key: key, value: stored }).then(function () {
        memo.set(key, { value: stored });
      });
    },
    delete: function (key) {
      checkKey(key, 'state.delete key');
      return call('state.delete', { key: key }).then(function () { memo.delete(key); });
    },
    keys: function () { return Array.from(memo.keys()); },
  };

  // ------------------------------------------------------------------------------------------
  // Interfaces: a small hooks runtime rendering to serializable trees
  // ------------------------------------------------------------------------------------------

  var COMPONENTS = boot.components;
  var INTRINSIC = new Set(COMPONENTS);
  var FRAGMENT = '__sa_Fragment';
  var uiIn = stateIn.ui || {};
  var openUis = new Map();
  var hookCtx = null;
  var activeUi = null;

  function h(type, props) {
    var children = [];
    for (var i = 2; i < arguments.length; i++) children.push(arguments[i]);
    var p = props || {};
    return { $$sa: true, type: type, props: p, key: p.key, children: children };
  }

  function renderNodes(el, path, ui, out) {
    if (el === null || el === undefined || el === false || el === true || el === '') return;
    if (typeof el === 'string' || typeof el === 'number') { out.push(String(el)); return; }
    if (Array.isArray(el)) {
      for (var i = 0; i < el.length; i++) {
        var c = el[i];
        var seg = c && c.$$sa && c.key !== undefined && c.key !== null ? 'k' + String(c.key) : String(i);
        renderNodes(c, path + '.' + seg, ui, out);
      }
      return;
    }
    if (!el || el.$$sa !== true) {
      if (el && typeof el.then === 'function') throw new TypeError('A component returned a Promise: components must be synchronous; load data before api.ui.present or in an event handler.');
      throw new TypeError('Cannot render ' + describe(el) + ' (at ' + path + ').');
    }
    if (el.type === FRAGMENT) { renderNodes(el.children, path, ui, out); return; }
    if (typeof el.type === 'function') {
      var cpath = path + ':' + (el.type.name || 'Component');
      ui.mounted.add(cpath);
      var props = Object.assign({}, el.props);
      if (el.children.length) props.children = el.children.length === 1 ? el.children[0] : el.children;
      var prev = hookCtx;
      hookCtx = { ui: ui, path: cpath, index: 0 };
      var result;
      try { result = el.type(props); } finally { hookCtx = prev; }
      renderNodes(result, cpath, ui, out);
      return;
    }
    if (typeof el.type !== 'string' || !INTRINSIC.has(el.type))
      throw new TypeError('Unknown component ' + JSON.stringify(typeof el.type === 'string' ? el.type : describe(el.type)) + '. Import components from "@spainassist/ui": ' + COMPONENTS.filter(function (c) { return c !== 'Root'; }).join(', ') + '.');
    var nodeProps = {};
    var keys = Object.keys(el.props);
    for (var k = 0; k < keys.length; k++) {
      var name = keys[k];
      if (name === 'key' || name === 'children') continue;
      var v = el.props[name];
      if (v === undefined) continue;
      if (typeof v === 'function') {
        var id = path + '#' + name;
        ui.handlers.set(id, v);
        nodeProps[name] = { $handler: id };
      } else {
        nodeProps[name] = JSON.parse(toJson(v, '<' + el.type + '> prop "' + name + '"'));
      }
    }
    if (el.type === 'Map' && nodeProps.value === undefined && el.props.selectedOption !== undefined) {
      var so = el.props.selectedOption;
      nodeProps.value = so && typeof so === 'object' ? so.value : so;
      delete nodeProps.selectedOption;
    } else if (el.type === 'Map') delete nodeProps.selectedOption;
    var kids = [];
    renderNodes(el.children, path + '/', ui, kids);
    out.push({ type: el.type, props: nodeProps, children: kids });
  }

  function renderUi(ui) {
    ui.handlers = new Map();
    var mounted = new Set();
    ui.mounted = mounted;
    var children = [];
    var prevActive = activeUi;
    activeUi = ui;
    // render is the root component, so it may call hooks itself: present(key, () => { useDurableState… }).
    try { renderNodes(h(ui.render, null), 'r', ui, children); } finally { activeUi = prevActive; }
    ui.hooks.forEach(function (_, p) { if (!mounted.has(p)) ui.hooks.delete(p); });
    // An empty card would wait for an answer the user has no way to give.
    if (!children.some(function (c) { return typeof c !== 'string' || c.trim(); }))
      throw new TypeError('ui.present("' + ui.key + '"): the render function showed nothing (it returned null or no components). Return what the user should see, e.g. () => <Form title="…">…</Form>.');
    return { type: 'Root', props: {}, children: children };
  }

  function failUi(ui, error) {
    if (!ui.open) return;
    ui.open = false;
    openUis.delete(ui.key);
    ui.reject(error);
  }

  function scheduleRender(ui) {
    if (ui.scheduled || !ui.open) return;
    ui.scheduled = true;
    Promise.resolve().then(function () {
      ui.scheduled = false;
      if (!ui.open || ui.closing) return;
      var tree;
      try { tree = renderUi(ui); } catch (e) { failUi(ui, e); return; }
      var json = JSON.stringify(tree);
      if (json === ui.lastJson) return;
      ui.lastJson = json;
      ui.rev++;
      emit('ui.render', { key: ui.key, rev: ui.rev, tree: tree });
    });
  }

  function currentHook(what) {
    if (!hookCtx) throw new Error(what + ' can only be called while a component renders (in the render function given to api.ui.present or a component it renders).');
    return hookCtx;
  }

  function slot(what, init) {
    var ctx = currentHook(what);
    var list = ctx.ui.hooks.get(ctx.path);
    if (!list) { list = []; ctx.ui.hooks.set(ctx.path, list); }
    var i = ctx.index++;
    if (!(i in list)) list[i] = init();
    return { cell: list[i], ui: ctx.ui };
  }

  function useState(initial) {
    var s = slot('useState', function () { return { value: typeof initial === 'function' ? initial() : initial }; });
    var cell = s.cell;
    if (!cell.set) {
      var ui = s.ui;
      cell.set = function (next) {
        var value = typeof next === 'function' ? next(cell.value) : next;
        if (Object.is(value, cell.value)) return;
        cell.value = value;
        scheduleRender(ui);
      };
    }
    return [cell.value, cell.set];
  }

  function useDurableState(name, initial) {
    var ctx = currentHook('useDurableState');
    checkKey(name, 'useDurableState name');
    var ui = ctx.ui;
    var has = Object.prototype.hasOwnProperty.call(ui.durable, name);
    var value = has ? clone(ui.durable[name]) : (typeof initial === 'function' ? initial() : initial);
    var setter = ui.setters.get(name);
    if (!setter) {
      setter = function (next) {
        var current = Object.prototype.hasOwnProperty.call(ui.durable, name) ? clone(ui.durable[name]) : value;
        var v = typeof next === 'function' ? next(current) : next;
        var stored = JSON.parse(toJson(v, 'useDurableState("' + name + '") value'));
        if (JSON.stringify(stored) === JSON.stringify(ui.durable[name])) return;
        ui.durable[name] = stored;
        emit('ui.durable', { key: ui.key, name: name, value: stored });
        scheduleRender(ui);
      };
      ui.setters.set(name, setter);
    }
    return [value, setter];
  }

  function depsChanged(a, b) {
    if (!a || !b || a.length !== b.length) return true;
    for (var i = 0; i < a.length; i++) if (!Object.is(a[i], b[i])) return true;
    return false;
  }

  function useMemo(fn, deps) {
    var s = slot('useMemo', function () { return {}; });
    if (!('value' in s.cell) || depsChanged(s.cell.deps, deps)) {
      s.cell.value = fn();
      s.cell.deps = deps;
    }
    return s.cell.value;
  }

  function useCallback(fn, deps) { return useMemo(function () { return fn; }, deps); }
  function useRef(initial) { return slot('useRef', function () { return { current: initial }; }).cell; }

  function present(key, render) {
    checkKey(key, 'ui.present key');
    if (typeof render !== 'function') throw new TypeError('ui.present("' + key + '", render): render must be a function returning a component, e.g. () => <MyForm api={api} />.');
    var saved = uiIn[key];
    if (saved && saved.status === 'closed') return Promise.resolve(clone(saved.result));
    if (openUis.has(key)) return Promise.reject(new Error('The interface "' + key + '" is already open.'));
    return new Promise(function (resolve, reject) {
      var ui = {
        key: key, render: render, open: true, closing: false, scheduled: false,
        durable: saved && saved.durable ? clone(saved.durable) : {},
        hooks: new Map(), setters: new Map(), handlers: new Map(), mounted: new Set(),
        rev: saved && typeof saved.rev === 'number' ? saved.rev : 0,
        lastJson: '', resolve: resolve, reject: reject,
        // Where the workflow presented it: a failure the app reports later is thrown from here.
        origin: new Error('').stack,
      };
      var tree;
      try { tree = renderUi(ui); } catch (e) { reject(e); return; }
      ui.lastJson = JSON.stringify(tree);
      ui.rev++;
      openUis.set(key, ui);
      call('ui.open', { key: key, rev: ui.rev, tree: tree }).then(null, function (e) { failUi(ui, e); });
    });
  }

  function close(result, key) {
    var ui;
    if (key !== undefined) {
      checkKey(key, 'ui.close key');
      ui = openUis.get(key);
      if (!ui) return Promise.reject(new Error('No open interface "' + key + '".'));
    } else if (activeUi) {
      ui = activeUi;
    } else if (openUis.size === 1) {
      ui = openUis.values().next().value;
    } else {
      return Promise.reject(new Error(openUis.size ? 'Several interfaces are open: pass the key, api.ui.close(result, key).' : 'No interface is open.'));
    }
    if (ui.closing || !ui.open) return Promise.resolve();
    ui.closing = true;
    var stored;
    try { stored = JSON.parse(toJson(result, 'api.ui.close result')); } catch (e) { ui.closing = false; return Promise.reject(e); }
    return call('ui.close', { key: ui.key, result: stored }).then(function () {
      ui.open = false;
      openUis.delete(ui.key);
      uiIn[ui.key] = { status: 'closed', result: stored };
      ui.resolve(clone(stored));
    }, function (e) {
      ui.closing = false;
      failUi(ui, e);
      throw e;
    });
  }

  function dispatch(key, handler, rev, valueJson) {
    var ui = openUis.get(key);
    if (!ui || !ui.open || ui.closing) return 'closed';
    if (handler === ${JSON.stringify(UI_FAILED)}) {
      // The app could not draw it: present() fails as if the interface had been refused.
      var failure = new CodemodeError({
        code: 'bad_request', op: 'ui.present', effect: 'not_started', message: String(JSON.parse(valueJson)),
      });
      if (ui.origin) failure.stack = ui.origin;
      failUi(ui, failure);
      return 'ok';
    }
    var fn = ui.handlers.get(handler);
    if (!fn) return 'stale';
    var value = valueJson === '' || valueJson === undefined ? undefined : JSON.parse(valueJson);
    var prev = activeUi;
    activeUi = ui;
    try {
      var r = value === undefined ? fn() : fn(value);
      if (r && typeof r.then === 'function') r.then(null, function (e) { failUi(ui, e); });
    } catch (e) {
      failUi(ui, e);
    } finally {
      activeUi = prev;
    }
    return 'ok';
  }

  var uiModule = { h: h, Fragment: FRAGMENT, useState: useState, useDurableState: useDurableState, useMemo: useMemo, useCallback: useCallback, useRef: useRef };
  COMPONENTS.forEach(function (c) { if (c !== 'Root') uiModule[c] = c; });

  var ui = {
    present: present,
    close: close,
    useState: useState,
    useDurableState: useDurableState,
    useMemo: useMemo,
    useCallback: useCallback,
    useRef: useRef,
    isOpen: function (key) { return openUis.has(key); },
  };

  // ------------------------------------------------------------------------------------------
  // Procedures
  // ------------------------------------------------------------------------------------------

  class Procedure {
    constructor(data) { this._set(data); }
    _set(data) {
      var self = this;
      Object.keys(data).forEach(function (k) { self[k] = data[k]; });
    }
    update(patch) {
      var self = this;
      return call('procedures.update', { id: this.id, expectedVersion: this.version, patch: patch || {} })
        .then(function (data) { self._set(data); return self; });
    }
    refresh() {
      var self = this;
      return call('procedures.get', { id: this.id }).then(function (data) { self._set(data); return self; });
    }
    context() { return call('procedures.context', { id: this.id }); }
    setContext(context) { return call('procedures.setContext', { id: this.id, context: context }); }
  }

  var procedures = {
    list: function (opts) {
      return call('procedures.list', opts || {}).then(function (list) {
        return list.map(function (d) { return new Procedure(d); });
      });
    },
    get: function (id) { return call('procedures.get', { id: id }).then(function (d) { return new Procedure(d); }); },
    getOrCreate: function (input) {
      if (!input || typeof input !== 'object') throw new TypeError('procedures.getOrCreate({ id, title }) needs an object.');
      return call('procedures.getOrCreate', input).then(function (d) {
        if (boot.procedures.indexOf(d.id) === -1) boot.procedures.push(d.id);
        return new Procedure(d);
      });
    },
    context: function (id) { return call('procedures.context', { id: id }); },
  };

  // ------------------------------------------------------------------------------------------
  // Browser: Playwright-shaped pages and locators, executed by the app
  // ------------------------------------------------------------------------------------------

  function fnSource(fn, what) {
    if (typeof fn === 'string') return '(' + fn + ')';
    if (typeof fn !== 'function') throw new TypeError(what + ' needs a function.');
    return String(fn);
  }

  /** RegExps cross the sandbox boundary as {$re, flags}. */
  function ser(value) {
    if (value instanceof RegExp) return { $re: value.source, flags: value.flags };
    if (Array.isArray(value)) return value.map(ser);
    if (value && typeof value === 'object') {
      var out = {};
      Object.keys(value).forEach(function (k) { out[k] = ser(value[k]); });
      return out;
    }
    return value;
  }

  /**
   * Members the runtime probes (promises, JSON, inspection) and that an object may lack quietly.
   */
  var PROBED = new Set(['then', 'catch', 'finally', 'toJSON', 'toString', 'valueOf', 'inspect', 'nodeType', '$$typeof', 'asymmetricMatch', 'length']);

  /**
   * obj, naming what it has when code reads a member it lacks: "locator.pressSequentially
   * does not exist" instead of QuickJS's bare "not a function", which models can't act on.
   */
  function strict(obj, what) {
    return new Proxy(obj, {
      get: function (target, key, receiver) {
        if (typeof key !== 'string' || key in target || PROBED.has(key)) return Reflect.get(target, key, receiver);
        var names = [];
        for (var o = target; o && o !== Object.prototype; o = Object.getPrototypeOf(o)) {
          Object.getOwnPropertyNames(o).forEach(function (n) {
            if (n !== 'constructor' && n.charAt(0) !== '_' && names.indexOf(n) === -1) names.push(n);
          });
        }
        throw new TypeError(what + '.' + key + ' does not exist. ' + what + ' has: ' + names.join(', ') + '.');
      },
    });
  }

  class Locator {
    constructor(page, chain) { this._page = page; this._chain = chain; return strict(this, 'locator'); }
    _with(step) { return new Locator(this._page, this._chain.concat([ser(step)])); }
    _op(op, extra) { return this._page._op(op, Object.assign({ target: this._chain }, extra || {})); }
    locator(selector, options) { return this._with(['locator', selector, options || null]); }
    getByRole(role, options) { return this._with(['getByRole', role, options || null]); }
    getByText(text, options) { return this._with(['getByText', text, options || null]); }
    getByLabel(text, options) { return this._with(['getByLabel', text, options || null]); }
    getByPlaceholder(text, options) { return this._with(['getByPlaceholder', text, options || null]); }
    getByTitle(text, options) { return this._with(['getByTitle', text, options || null]); }
    getByAltText(text, options) { return this._with(['getByAltText', text, options || null]); }
    getByTestId(id) { return this._with(['getByTestId', id]); }
    filter(options) { return this._with(['filter', options || {}]); }
    /** Matches this locator or other (Playwright's or). */
    or(other) {
      if (!(other instanceof Locator)) throw new TypeError('locator.or(other) needs a locator of the same page.');
      return this._with(['or', other._chain]);
    }
    nth(index) { return this._with(['nth', index]); }
    first() { return this._with(['first']); }
    last() { return this._with(['last']); }
    click(options) { return this._op('click', { options: options || null }); }
    dblclick() { return this._op('dblclick'); }
    hover() { return this._op('hover'); }
    focus() { return this._op('focus'); }
    fill(value, options) { return this._op('fill', { value: String(value), submit: !!(options && options.submit) }); }
    press(key) { return this._op('press', { key: key }); }
    /** Playwright's key-by-key typing; fill types key by key itself where a field needs it. */
    pressSequentially(text) { return this.fill(text); }
    /** Actions scroll to their element themselves; this only waits until it is there. */
    scrollIntoViewIfNeeded() { return this.waitFor({ state: 'attached' }); }
    type(text) { return this.fill(text); }
    check() { return this._op('check', { checked: true }); }
    uncheck() { return this._op('check', { checked: false }); }
    setChecked(checked) { return this._op('check', { checked: !!checked }); }
    selectOption(values) { return this._op('selectOption', { values: [].concat(values).map(function (v) { return typeof v === 'object' && v ? (v.label || v.value) : String(v); }) }); }
    /** Uploads saved documents (ids from api.vault.read) into a file field. */
    setInputFiles(documentIds) { return this._op('setInputFiles', { documentIds: [].concat(documentIds) }); }
    textContent() { return this._op('textContent'); }
    innerText() { return this._op('innerText'); }
    inputValue() { return this._op('inputValue'); }
    getAttribute(name) { return this._op('getAttribute', { name: name }); }
    isVisible() { return this._op('isVisible'); }
    isEnabled() { return this._op('isEnabled'); }
    isChecked() { return this._op('isChecked'); }
    count() { return this._op('count'); }
    allTextContents() { return this._op('allTextContents'); }
    allInnerTexts() { return this._op('allInnerTexts'); }
    ariaSnapshot() { return noAriaSnapshot(); }
    waitFor(options) { return this._op('waitFor', { options: options || null }); }
    evaluate(fn, arg) { return this._op('evaluate', { fn: fnSource(fn, 'locator.evaluate'), arg: arg === undefined ? null : arg }); }
    evaluateAll(fn, arg) { return this._op('evaluateAll', { fn: fnSource(fn, 'locator.evaluateAll'), arg: arg === undefined ? null : arg }); }
    all() {
      var self = this;
      return this.count().then(function (n) {
        var out = [];
        for (var i = 0; i < n; i++) out.push(self.nth(i));
        return out;
      });
    }
    toJSON() { return { locator: this._chain }; }
  }

  class Page {
    constructor(procedureId) { this.procedureId = procedureId; return strict(this, 'page'); }
    _op(op, args) { return call('browser.' + op, Object.assign({ procedureId: this.procedureId }, args || {})); }
    _loc(step) { return new Locator(this, [ser(step)]); }
    locator(selector, options) { return this._loc(['locator', selector, options || null]); }
    getByRole(role, options) { return this._loc(['getByRole', role, options || null]); }
    getByText(text, options) { return this._loc(['getByText', text, options || null]); }
    getByLabel(text, options) { return this._loc(['getByLabel', text, options || null]); }
    getByPlaceholder(text, options) { return this._loc(['getByPlaceholder', text, options || null]); }
    getByTitle(text, options) { return this._loc(['getByTitle', text, options || null]); }
    getByAltText(text, options) { return this._loc(['getByAltText', text, options || null]); }
    getByTestId(id) { return this._loc(['getByTestId', id]); }
    /** An element by its ref from page.snapshot() ("e12"). */
    ref(ref) { return this._loc(['ref', ref]); }
    goto(url, options) { return this._op('goto', { url: url, newTab: !!(options && options.newTab) }); }
    goBack() { return this._op('goBack'); }
    reload() { return this._op('reload'); }
    url() { return this._op('info').then(function (i) { return i.url; }); }
    title() { return this._op('info').then(function (i) { return i.title; }); }
    snapshot() { return this._op('snapshot'); }
    ariaSnapshot() { return noAriaSnapshot(); }
    press(key) { return this._op('press', { key: key }); }
    waitForTimeout(ms) { return this._op('wait', { seconds: Math.min(60, Math.max(0, Number(ms) || 0) / 1000) }); }
    waitForText(text, options) { return this._op('wait', { text: text, seconds: options && options.timeout ? options.timeout / 1000 : undefined }); }
    waitForTextGone(text, options) { return this._op('wait', { textGone: text, seconds: options && options.timeout ? options.timeout / 1000 : undefined }); }
    screenshot(options) { return this._op('screenshot', { fullPage: !!(options && options.fullPage) }); }
    evaluate(fn, arg) { return this._op('evaluate', { target: [], fn: fnSource(fn, 'page.evaluate'), arg: arg === undefined ? null : arg }); }
    tabs() { return this._op('tabs', { action: 'list' }); }
    selectTab(index) { return this._op('tabs', { action: 'select', index: index }); }
    closeTab(index) { return this._op('tabs', { action: 'close', index: index }); }
    close() { return this._op('close'); }
    reopenHeaded() { return this._op('reopenHeaded'); }
    downloads() { return this._op('downloads'); }
    fillFromVault(target, key, options) { return this._op('fillFromVault', { target: targetOf(target), key: key, submit: !!(options && options.submit) }); }
    fillFromUser(target, options) { return this._op('fillFromUser', Object.assign({ target: targetOf(target) }, options || {})); }
    loginClave(options) {
      var o = options || {};
      return this._op('loginClave', { username: targetOf(o.username), password: targetOf(o.password), rejected: !!o.rejected, message: o.message });
    }
    useCertificate(options) { return this._op('useCertificate', options || {}); }
    toJSON() { return { page: this.procedureId }; }
  }

  /** Playwright habit: say what to use instead of failing with "not a function". */
  function noAriaSnapshot() {
    return Promise.reject(new CodemodeError({ code: 'bad_request', message: 'ariaSnapshot() is not available: use page.snapshot() to see the page (refs included), and locator.innerText() or allInnerTexts() to read a part of it.' }));
  }

  function targetOf(target) {
    if (target instanceof Locator) return target._chain;
    if (typeof target === 'string') return [['ref', target]];
    throw new TypeError('Expected a locator (page.getByLabel(...)) or a ref from page.snapshot().');
  }

  function primaryProcedure(id) {
    var chosen = id || boot.procedures[0];
    if (!chosen) throw new CodemodeError({ code: 'bad_request', message: 'This workflow serves no procedure yet: call api.procedures.getOrCreate(...) first, or pass a procedure id.' });
    return chosen;
  }

  var browser = {
    currentPage: function (options) {
      var id = typeof options === 'string' ? options : options && options.procedureId;
      return Promise.resolve(new Page(primaryProcedure(id)));
    },
    page: function (procedureId) { return new Page(primaryProcedure(procedureId)); },
  };

  // ------------------------------------------------------------------------------------------
  // Everything else
  // ------------------------------------------------------------------------------------------

  function parallelize(tasks, options) {
    if (!Array.isArray(tasks)) throw new TypeError('parallelize(tasks) needs an array of promises or functions.');
    var limit = Math.max(1, Math.min(16, (options && options.concurrency) || 4));
    var results = new Array(tasks.length);
    var next = 0;
    function worker() {
      if (next >= tasks.length) return Promise.resolve();
      var i = next++;
      var t = tasks[i];
      return Promise.resolve()
        .then(function () { return typeof t === 'function' ? t() : t; })
        .then(function (value) { results[i] = { status: 'fulfilled', value: value }; },
              function (reason) { results[i] = { status: 'rejected', reason: reason }; })
        .then(worker);
    }
    var workers = [];
    for (var w = 0; w < Math.min(limit, tasks.length); w++) workers.push(worker());
    return Promise.all(workers).then(function () { return results; });
  }

  var images = [];
  var api = {
    workflowId: boot.workflowId,
    state: state,
    ui: ui,
    parallelize: parallelize,
    setStatus: function (status) { return call('setStatus', { status: String(status) }); },
    output: {
      image: function (image) {
        if (!image || typeof image.imageId !== 'string') throw new TypeError('output.image needs an image from page.screenshot() or documents.read().');
        images.push(image.imageId);
      },
    },
    procedures: procedures,
    workflows: {
      list: function () { return call('workflows.list'); },
      get: function (id) { return call('workflows.get', { id: id }); },
      cancel: function (id, reason) { return call('workflows.cancel', { id: id, reason: reason }); },
    },
    search: function (input) { return call('search', typeof input === 'string' ? { prompt: input } : input); },
    fetchUrl: function (url, options) { return call('fetchUrl', Object.assign({ url: url }, options || {})); },
    fetch: function (url, init) {
      var i = init || {};
      return call('fetch', { url: String(url), method: i.method, headers: i.headers, body: i.body }).then(function (r) {
        return {
          ok: r.status >= 200 && r.status < 300, status: r.status, statusText: r.statusText, url: r.url,
          headers: r.headers, redirected: r.redirected, truncated: r.truncated,
          text: function () { return Promise.resolve(r.text); },
          json: function () { return Promise.resolve().then(function () { return JSON.parse(r.text); }); },
        };
      });
    },
    boe: { search: function (input) { return call('boe.search', typeof input === 'string' ? { query: input } : input); } },
    vault: {
      read: function (options) { return call('vault.read', options || {}); },
      save: function (items) { return call('vault.save', { items: items }); },
    },
    documents: {
      read: function (id, options) { return call('documents.read', Object.assign({ id: id }, options || {})); },
      saveDownload: function (downloadId, name) { return call('documents.saveDownload', { downloadId: downloadId, name: name }); },
    },
    feedback: {
      search: function (input) { return call('feedback.search', typeof input === 'string' ? { query: input } : input); },
      submit: function (input) { return call('feedback.submit', input); },
      vote: function (id, vote) { return call('feedback.vote', { id: id, vote: vote }); },
    },
    user: {
      confirm: function (input) { return call('user.confirm', input).then(function (r) { return r.approved; }); },
      requestAction: function (input) {
        return call('user.requestAction', input).then(function (r) {
          // What the user wrote (a captcha's characters, a code) reaches the agent even when the
          // workflow drops it.
          if (r && r.note) host.log('[user] On "' + String((input || {}).title || '') + '" the user noted: ' + r.note);
          return r;
        });
      },
      requestCredential: function (input) { return call('user.requestCredential', input); },
      phoneCall: function (input) { return call('user.phoneCall', input); },
    },
  };

  function unavailable(name, why) {
    Object.defineProperty(api, name, {
      enumerable: false,
      get: function () { throw new CodemodeError({ code: 'policy_denied', message: 'api.' + name + ' is not available here: ' + why }); },
    });
  }

  api.browser = browser;
  // Models write api.memo for api.state.memo often enough to keep it working.
  Object.defineProperty(api, 'memo', { enumerable: false, value: function (key, fn) { return state.memo(key, fn); } });
  unavailable('agents', 'agents start no other agents.');
  Object.freeze(api.state); Object.freeze(api.ui);

  // ------------------------------------------------------------------------------------------
  // Modules and entry points for the host
  // ------------------------------------------------------------------------------------------

  /** URLSearchParams, as much as workflows use: QuickJS has none. */
  class URLSearchParamsLite {
    constructor(init) {
      this._pairs = [];
      var text = typeof init === 'string' ? init.replace(/^\?/, '') : '';
      if (text) text.split('&').forEach(function (part) {
        if (!part) return;
        var i = part.indexOf('=');
        var dec = function (x) { try { return decodeURIComponent(x.replace(/\+/g, ' ')); } catch (e) { return x; } };
        this._pairs.push(i === -1 ? [dec(part), ''] : [dec(part.slice(0, i)), dec(part.slice(i + 1))]);
      }, this);
      else if (init && typeof init === 'object') Object.keys(init).forEach(function (k) { this._pairs.push([k, String(init[k])]); }, this);
    }
    get(name) { var p = this._pairs.find(function (x) { return x[0] === name; }); return p ? p[1] : null; }
    getAll(name) { return this._pairs.filter(function (x) { return x[0] === name; }).map(function (x) { return x[1]; }); }
    has(name) { return this._pairs.some(function (x) { return x[0] === name; }); }
    set(name, value) { this.delete(name); this._pairs.push([name, String(value)]); }
    append(name, value) { this._pairs.push([name, String(value)]); }
    delete(name) { this._pairs = this._pairs.filter(function (x) { return x[0] !== name; }); }
    forEach(fn) { this._pairs.forEach(function (x) { fn(x[1], x[0]); }); }
    entries() { return this._pairs.map(function (x) { return [x[0], x[1]]; })[Symbol.iterator](); }
    keys() { return this._pairs.map(function (x) { return x[0]; })[Symbol.iterator](); }
    values() { return this._pairs.map(function (x) { return x[1]; })[Symbol.iterator](); }
    [Symbol.iterator]() { return this.entries(); }
    toString() { return this._pairs.map(function (x) { return encodeURIComponent(x[0]) + '=' + encodeURIComponent(x[1]); }).join('&'); }
  }

  /** URL for http(s) addresses, relative ones resolved against a base: QuickJS has none. */
  class URLLite {
    constructor(input, base) {
      var text = String(input).trim();
      var m = /^([a-zA-Z][a-zA-Z0-9+.-]*:)\/\/([^\/?#]*)([^?#]*)(\?[^#]*)?(#.*)?$/.exec(text);
      if (!m) {
        if (base === undefined) throw new TypeError('Invalid URL: ' + text);
        var b = base instanceof URLLite ? base : new URLLite(base);
        var path = b.pathname;
        if (/^\/\//.test(text)) return new URLLite(b.protocol + text);
        var rest = /^([^?#]*)(\?[^#]*)?(#.*)?$/.exec(text);
        var p = rest[1];
        if (p === '') p = path;
        else if (p.charAt(0) !== '/') p = path.replace(/[^\/]*$/, '') + p;
        var out = [];
        p.split('/').forEach(function (seg, i, all) {
          if (seg === '..') { if (out.length > 1) out.pop(); if (i === all.length - 1) out.push(''); }
          else if (seg === '.') { if (i === all.length - 1) out.push(''); }
          else out.push(seg);
        });
        var search = rest[2] !== undefined ? rest[2] : (rest[1] === '' ? b.search : '');
        return new URLLite(b.origin + out.join('/') + search + (rest[3] || ''));
      }
      this.protocol = m[1].toLowerCase();
      this.host = m[2].toLowerCase();
      var hp = /^(.*?)(?::(\d+))?$/.exec(this.host);
      this.hostname = hp[1];
      this.port = hp[2] || '';
      this.pathname = m[3] || '/';
      this.search = m[4] && m[4] !== '?' ? m[4] : '';
      this.hash = m[5] && m[5] !== '#' ? m[5] : '';
      this.searchParams = new URLSearchParamsLite(this.search);
    }
    get origin() { return this.protocol + '//' + this.host; }
    get href() {
      var q = this.searchParams.toString();
      return this.origin + this.pathname + (q ? '?' + q : '') + this.hash;
    }
    toString() { return this.href; }
    toJSON() { return this.href; }
  }

  var modules = { '@spainassist/ui': uiModule };
  function requireModule(name) {
    if (Object.prototype.hasOwnProperty.call(modules, name)) return modules[name];
    throw new Error('Cannot import "' + name + '": only "@spainassist/ui" is available.');
  }

  if (typeof g.URL === 'undefined') { g.URLSearchParams = URLSearchParamsLite; g.URL = URLLite; }
  // What a module forgets to import still works: the components and hooks are globals too.
  Object.keys(uiModule).forEach(function (k) { if (!(k in g)) g[k] = uiModule[k]; });
  g.__sa_h = h;
  g.__sa_Fragment = FRAGMENT;
  g.__sa_dispatch = dispatch;
  g.__sa_images = function () { return JSON.stringify(images); };
  g.__sa_openUis = function () { return JSON.stringify(Array.from(openUis.keys())); };
  g.__sa_main = function (factory) {
    var module = { exports: {} };
    factory(module, module.exports, requireModule);
    var main = module.exports.main || module.exports.default;
    if (typeof main !== 'function') throw new TypeError('The module must export an async function main(api).');
    return Promise.resolve().then(function () { return main(strict(api, 'api')); }).then(function (value) {
      return value === undefined ? '' : toJson(value, 'The value main returned');
    });
  };
})();
`;
