/* ================================================
   SwiftFlow — admin authentication (optional)

   Only does anything when window.SHIFTFLOW_SUPABASE_URL and
   window.SHIFTFLOW_SUPABASE_ANON_KEY are set (see index.html and the
   README's "Deploying for real" section). Without them, isConfigured()
   returns false and script.js falls back to the original zero-config
   admin flow — nothing about local dev (node server.js) changes.

   The anon key is meant to be public (it's the whole point of Supabase's
   row-level-security model) — it identifies the project, it doesn't grant
   access on its own. Never put the service_role key here.
   ================================================ */
window.ShiftFlowAuth = (function () {
  "use strict";

  // index.html is shared between local dev (server.js, single-tenant,
  // PIN-based) and the real deployment (Vercel + Supabase, multi-tenant) —
  // the production keys have to be baked into that one file for Vercel to
  // serve them, which means they're technically present even when running
  // locally. Multi-tenant auth would be actively broken against server.js
  // (it has no concept of Supabase sessions or per-admin orgs), so it's
  // switched off by hostname rather than just by whether the keys exist.
  var isLocalDev = /^(localhost|127\.0\.0\.1)$/.test(window.location.hostname);
  var URL = window.SHIFTFLOW_SUPABASE_URL || "";
  var KEY = window.SHIFTFLOW_SUPABASE_ANON_KEY || "";
  var client = (!isLocalDev && URL && KEY && window.supabase && window.supabase.createClient)
    ? window.supabase.createClient(URL, KEY)
    : null;

  function isConfigured() {
    return !!client;
  }

  function getSession() {
    if (!client) return Promise.resolve(null);
    return client.auth.getSession().then(function (r) {
      return (r.data && r.data.session) || null;
    });
  }

  function getAccessToken() {
    return getSession().then(function (s) { return s ? s.access_token : null; });
  }

  function signInWithPassword(email, password) {
    if (!client) return Promise.resolve({ error: "This deployment doesn't have admin sign-in configured." });
    return client.auth.signInWithPassword({ email: email, password: password }).then(function (r) {
      return { error: r.error ? r.error.message : null, session: r.data && r.data.session };
    });
  }

  function signUp(email, password) {
    if (!client) return Promise.resolve({ error: "This deployment doesn't have admin sign-in configured." });
    // Without this, Supabase falls back to the project's "Site URL" dashboard
    // setting for the confirmation email's link — which is easy to leave
    // pointed at whatever it defaulted to (often localhost) and forget
    // about. Saying explicitly where to come back to means the link is
    // right regardless of that setting, as long as this exact URL is also
    // added to the project's Redirect URLs allow-list (a Supabase security
    // requirement — see README "Turning on admin sign-in").
    return client.auth.signUp({
      email: email,
      password: password,
      options: { emailRedirectTo: window.location.origin + window.location.pathname }
    }).then(function (r) {
      var needsConfirmation = !!(r.data && r.data.user && !r.data.session);
      return { error: r.error ? r.error.message : null, session: r.data && r.data.session, needsConfirmation: needsConfirmation };
    });
  }

  function signOut() {
    if (!client) return Promise.resolve();
    return client.auth.signOut();
  }

  function onAuthChange(callback) {
    if (!client) return;
    client.auth.onAuthStateChange(function (_event, session) { callback(session); });
  }

  // Uploads straight to Supabase Storage using a one-time signed URL the
  // backend handed out (see api/router.js's /chat-media-upload-url) — the
  // token itself is the authorization, so this works whether the caller
  // is a signed-in admin or a worker with no Supabase account at all.
  function uploadToSignedUrl(path, token, file) {
    if (!client) return Promise.resolve({ error: "This deployment doesn't have media uploads configured." });
    return client.storage.from("chat-media").uploadToSignedUrl(path, token, file).then(function (r) {
      return { error: r.error ? r.error.message : null };
    });
  }

  return {
    isConfigured: isConfigured,
    getSession: getSession,
    getAccessToken: getAccessToken,
    signInWithPassword: signInWithPassword,
    signUp: signUp,
    signOut: signOut,
    onAuthChange: onAuthChange,
    uploadToSignedUrl: uploadToSignedUrl
  };
})();
