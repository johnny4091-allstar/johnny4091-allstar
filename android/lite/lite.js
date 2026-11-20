/* Aurora Lite: fills in what older Android System WebViews (Android 7, Fire TV Stick 4K 1st gen) don't have yet. Runs before the app. */
(function () {
  'use strict';
  window.AURORA_LITE = true;
  var A = Array.prototype, O = Object, S = String.prototype;
  function def(obj, name, fn) { if (!obj[name]) { try { O.defineProperty(obj, name, { value: fn, writable: true, configurable: true }); } catch (e) { obj[name] = fn; } } }
  def(A, 'flat', function (depth) { var d = depth === undefined ? 1 : Number(depth), out = []; (function go(arr, n) { for (var i = 0; i < arr.length; i++) { if (Array.isArray(arr[i]) && n > 0) go(arr[i], n - 1); else out.push(arr[i]); } })(this, d); return out; });
  def(A, 'flatMap', function (fn, thisArg) { var out = []; for (var i = 0; i < this.length; i++) { var r = fn.call(thisArg, this[i], i, this); if (Array.isArray(r)) out.push.apply(out, r); else out.push(r); } return out; });
  def(A, 'includes', function (v, from) { for (var i = from || 0; i < this.length; i++) { if (this[i] === v || (v !== v && this[i] !== this[i])) return true; } return false; });
  def(A, 'at', function (i) { i = Math.trunc(i) || 0; if (i < 0) i += this.length; return this[i]; });
  def(A, 'findLast', function (fn, t) { for (var i = this.length - 1; i >= 0; i--) { if (fn.call(t, this[i], i, this)) return this[i]; } return undefined; });
  def(S, 'at', function (i) { i = Math.trunc(i) || 0; if (i < 0) i += this.length; return i >= 0 && i < this.length ? this.charAt(i) : undefined; });
  def(S, 'replaceAll', function (find, rep) { if (find instanceof RegExp) return this.replace(find, rep); return this.split(String(find)).join(typeof rep === 'function' ? rep(String(find)) : rep); });
  def(S, 'trimStart', S.trimLeft || function () { return this.replace(/^\s+/, ''); });
  def(S, 'trimEnd', S.trimRight || function () { return this.replace(/\s+$/, ''); });
  def(O, 'fromEntries', function (it) { var o = {}; for (var e of it) o[e[0]] = e[1]; return o; });
  def(O, 'hasOwn', function (o, k) { return Object.prototype.hasOwnProperty.call(o, k); });
  def(Promise, 'allSettled', function (list) {
    return Promise.all(Array.prototype.map.call(list, function (p) {
      return Promise.resolve(p).then(function (value) { return { status: 'fulfilled', value: value }; }, function (reason) { return { status: 'rejected', reason: reason }; });
    }));
  });
  if (typeof globalThis === 'undefined') { window.globalThis = window; }
  if (typeof queueMicrotask === 'undefined') { window.queueMicrotask = function (fn) { Promise.resolve().then(fn); }; }
  if (window.AbortSignal && !AbortSignal.timeout && window.AbortController) {
    AbortSignal.timeout = function (ms) { var c = new AbortController(); setTimeout(function () { c.abort(); }, ms); return c.signal; };
  }
  if (typeof structuredClone === 'undefined') { window.structuredClone = function (v) { return v === undefined ? v : JSON.parse(JSON.stringify(v)); }; }
  if (window.Element && !Element.prototype.closest) {
    Element.prototype.closest = function (sel) { var e = this; while (e && e.nodeType === 1) { if ((e.matches || e.msMatchesSelector).call(e, sel)) return e; e = e.parentElement; } return null; };
  }
  // The Lite look: no moving backgrounds, fades or blur. Set before the page draws, so it never flashes the full look.
  document.documentElement.className += ' lite';
})();
