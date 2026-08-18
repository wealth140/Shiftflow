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
      fetch(BASE + "/state", { method: "GET" })
        .then(function (res) { available = res.ok; return available; })
        .catch(function () { available = false; return false; }),
      TIMEOUT_MS
    ).then(function (result) {
      if (result === null) { available = false; return false; } // timed out
      return result;
    });
  }

  function request(path, options) {
    return checkBackend().then(function (ok) {
      if (!ok) return null;
      return withTimeout(
        fetch(BASE + path, options)
          .then(function (res) { return res.ok ? res.json() : null; })
          .catch(function () { return null; }),
        TIMEOUT_MS
      );
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
    getState: function () { return get("/state"); },
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
