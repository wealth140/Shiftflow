/* ================================================
   ShiftFlow — API data layer
   If server.js is running (node server.js), this talks
   to the real backend and every change is saved to disk.
   If there's no backend reachable (e.g. this file opened
   directly, or the standalone preview), every call fails
   quietly and the caller keeps using its in-memory data —
   the app still works, it just won't persist.

   By default this assumes the frontend and backend share
   an origin (relative "/api" — e.g. you're loading index.html
   directly from server.js's own static file serving). If you
   host the frontend separately (e.g. GitHub Pages) and the
   backend elsewhere (e.g. Render, Railway, Fly), set
   window.SHIFTFLOW_API_URL to the backend's full URL before
   this script runs — set it as an inline script placed right
   before this one loads in index.html, e.g.:
     window.SHIFTFLOW_API_URL = "https://your-backend.example.com/api";
   ================================================ */
window.ShiftFlowAPI = (function () {
  "use strict";

  var BASE = window.SHIFTFLOW_API_URL || "/api";
  var available = null; // null = unknown, true/false once checked
  var TIMEOUT_MS = 2500;
  var inviteToken = null; // set once via setInviteToken() when a worker arrives via their personal ?invite= link

  function withTimeout(promise, ms) {
    var timeoutId;
    var timeout = new Promise(function (resolve) {
      timeoutId = setTimeout(function () { resolve(null); }, ms);
    });
    return Promise.race([promise, timeout]).then(function (result) {
      clearTimeout(timeoutId);
      return result;
    });
  }

  function checkBackend() {
    if (available !== null) return Promise.resolve(available);
    return withTimeout(
      // Any real HTTP response (even a 401 — the multi-tenant backend
      // requires auth on this same route) proves a backend is reachable.
      // Only a network-level failure means "there's genuinely no backend".
      fetch(BASE + "/state", { method: "GET" })
        .then(function () { available = true; return true; })
        .catch(function () { available = false; return false; }),
      TIMEOUT_MS
    ).then(function (result) {
      if (result === null) { available = false; return false; } // timed out
      return result;
    });
  }

  // When admin auth is configured (see supabase-auth.js), attach the
  // signed-in admin's token so the backend can tell an authenticated admin
  // apart from an anonymous caller on admin-only routes. Harmless no-op
  // when auth isn't configured for this deployment.
  //
  // Skipped entirely once an invite token is set: Supabase persists the
  // admin's session in localStorage, so if the same browser that just
  // signed in as an admin also opens (or still has open) a worker's
  // ?invite= link, the admin token would otherwise get attached to that
  // request too — and the backend would resolve it as the admin, not the
  // worker the link is actually for.
  function withAuthHeader(options) {
    if (inviteToken) return Promise.resolve(options);
    if (!window.ShiftFlowAuth || !window.ShiftFlowAuth.isConfigured()) return Promise.resolve(options);
    return window.ShiftFlowAuth.getAccessToken().then(function (token) {
      if (!token) return options;
      options.headers = options.headers || {};
      options.headers.Authorization = "Bearer " + token;
      return options;
    });
  }

  // A worker's personal invite link (?invite=...) is their whole
  // credential on the multi-tenant backend — every call while signed in
  // that way carries it so the server knows which organization/worker
  // this is. No-op for admins and for local dev (server.js ignores it).
  function withInviteToken(path) {
    if (!inviteToken) return path;
    return path + (path.indexOf("?") === -1 ? "?" : "&") + "invite=" + encodeURIComponent(inviteToken);
  }

  function request(path, options) {
    return checkBackend().then(function (ok) {
      if (!ok) return null;
      return withAuthHeader(options).then(function (opts) {
        return withTimeout(
          fetch(BASE + withInviteToken(path), opts)
            .then(function (res) { return res.ok ? res.json() : null; })
            .catch(function () { return null; }),
          TIMEOUT_MS
        );
      });
    });
  }

  function get(path) {
    return request(path, { method: "GET" });
  }
  function post(path, body) {
    return request(path, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body || {})
    });
  }
  function del(path) {
    return request(path, { method: "DELETE" });
  }

  return {
    checkBackend: checkBackend,
    setInviteToken: function (token) { inviteToken = token || null; },
    getState: function () { return get("/state"); },
    getJoinInfo: function (orgId) { return get("/join-info?org=" + encodeURIComponent(orgId)); },
    joinOrg: function (payload) { return post("/join", payload); },
    setOrg: function (orgType) { return post("/org", { orgType: orgType }); },
    setScheduleConfig: function (cfg) { return post("/schedule-config", cfg || {}); },
    addWorker: function (worker) { return post("/workers", worker); },
    removeWorker: function (id) { return del("/workers/" + id); },
    setWorkerPin: function (id, pin) { return post("/workers/" + id + "/pin", { pin: pin }); },
    setWorkerStatus: function (id, status) { return post("/workers/" + id + "/status", { status: status }); },
    sendInvite: function (id) { return post("/workers/" + id + "/invite", {}); },
    markInvited: function (id) { return post("/workers/" + id + "/mark-invited", {}); },
    setDuty: function (workerId, day, duty) { return post("/duties", { workerId: workerId, day: day, duty: duty }); },
    setChurchAssignment: function (duty, service, workerId) { return post("/church-assignments", { duty: duty, service: service, workerId: workerId }); },
    resolveSwap: function (id, status) { return post("/swaps/" + id, { status: status }); },
    requestSwap: function (swap) { return post("/swaps", swap); },
    logAttendance: function (entry) { return post("/attendance", entry); },
    postChatMessage: function (channel, message) { return post("/chat/" + channel, message); },
    addAnnouncement: function (announcement) { return post("/announcements", announcement); }
  };
})();
