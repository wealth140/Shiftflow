/* ================================================
   ShiftFlow — admin authentication (optional)

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

  var URL = window.SHIFTFLOW_SUPABASE_URL || "";
  var KEY = window.SHIFTFLOW_SUPABASE_ANON_KEY || "";
  var client = (URL && KEY && window.supabase && window.supabase.createClient)
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

  return {
    isConfigured: isConfigured,
    getSession: getSession,
    getAccessToken: getAccessToken,
    signInWithPassword: signInWithPassword,
    signUp: signUp,
    signOut: signOut,
    onAuthChange: onAuthChange
  };
})();
