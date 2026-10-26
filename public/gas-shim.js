/**
 * gas-shim.js — Compatibility shim for `window.google.script.run`.
 * Implements the same chainable API (.withSuccessHandler().withFailureHandler().fn(args))
 * and forwards every call to POST /api/rpc as { fn, args }.
 * Session auth rides on the HttpOnly `crm_session` cookie — nothing is read from storage.
 */
(function () {
  function post(fn, args) {
    return fetch('/api/rpc', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ fn: fn, args: args }),
      credentials: 'same-origin',
    }).then(function (res) {
      if (res.status === 401 || res.status === 403) {
        return { success: false, code: 'SESSION_EXPIRED', message: 'Session expired. Please log in again.' };
      }
      return res.json();
    });
  }

  /** One chainable runner: .withSuccessHandler(cb).withFailureHandler(cb).anyFn(args) */
  function makeChain() {
    var state = { onS: null, onF: null };
    var handle = {
      withSuccessHandler: function (cb) { state.onS = cb; return proxied; },
      withFailureHandler: function (cb) { state.onF = cb; return proxied; },
    };
    var proxied = new Proxy(handle, {
      get: function (target, prop) {
        if (prop in target) return target[prop];
        if (typeof prop === 'string') {
          return function () {
            var args = Array.prototype.slice.call(arguments);
            var fn = prop;
            post(fn, args).then(
              function (data) {
                if (state.onS) { try { state.onS(data); } catch (e) { console.error('[shim] success handler error', e); } }
              },
              function (err) {
                if (state.onF) state.onF(err);
                else console.error('[shim] RPC ' + fn + ' failed:', err);
              }
            );
            return proxied;
          };
        }
        return undefined;
      },
    });
    return proxied;
  }

  // Any property on google.script.run starts a chain — matches GAS semantics
  // (both .fnName(...) directly and .withSuccessHandler(...).fnName(...) work).
  window.google = window.google || {};
  window.google.script = window.google.script || {};
  window.google.script.run = new Proxy({}, {
    get: function (target, prop) {
      if (typeof prop === 'string') return makeChain()[prop];
      return undefined;
    },
  });
})();
