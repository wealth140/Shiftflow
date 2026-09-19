/* ================================================
   Onixora — production API (Vercel + Supabase), multi-tenant

  Every church gets its own organization (team, ministries, schedule,
  swaps, attendance, chat, announcements). Supabase memberships determine
  whether a caller is a Pastor, Coordinator, or Ministry Leader.

   Two ways in:
     - Church staff: signs in with Supabase Auth (see supabase-auth.js).
       Every staff route requires a valid Bearer token and a membership in
       the requested church. Worker invite links remain limited to workers.
     - Worker: never has a Supabase account. Their invite link carries a
       random, unguessable token (?invite=...) that resolves straight to
       them — which organization, which worker — with no PIN and no
       picking their name off a list. That token IS their credential, so
       treat it like a password: it's what "Copy invite"/"Email invite"
       on the Team tab hands out, and regenerating a worker's invite
       (delete + re-add, for now) invalidates the old one.

   Local dev (`node server.js` + data.json) is intentionally still
   single-tenant and PIN-based — it's the zero-config quick-start path,
   not meant to demo multi-tenancy. This file is the real, multi-org
   deployment.

   Requires on the Vercel project:
     SUPABASE_URL, SUPABASE_SERVICE_KEY — service_role key, server-side
       only secret, never sent to the browser.
   Optional (real invite emails):
     RESEND_API_KEY, EMAIL_FROM

   One-time setup: run the SQL in README.md ("Deploying for real") against
   your Supabase project before the first request.
   ================================================ */
const { createClient } = require("@supabase/supabase-js");
const https = require("https");
const crypto = require("crypto");

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);

const RESEND_API_KEY = process.env.RESEND_API_KEY || "";
const EMAIL_FROM = process.env.EMAIL_FROM || "Onixora <onboarding@resend.dev>";

var DEFAULT_ORG_DATA = {
  orgType: "church", orgName: null, team: [], duties: {}, churchAssignments: {}, swaps: [],
  attendance: [], chat: { general: [], schedule: [], announcements: [] }, announcements: [],
  scheduleDays: null, jobTypes: null
};

// A short, speakable stand-in for the org's uuid — nothing new to store,
// derived from the org's own id and (when set) its name, e.g. "GRACE-4821".
// Not cryptographically unique across an unbounded number of orgs, but
// plenty for this app's scale, and it means a join code needs no schema
// migration or separate admin-facing setup step. One consequence of
// deriving it from the name: renaming an organization changes its code —
// a reasonable trade-off for not needing to persist a separate value, but
// worth knowing if an old, already-shared code stops validating.
function shortJoinCode(orgId, orgName) {
  var idHex = String(orgId || "").replace(/-/g, "").slice(0, 8) || "0";
  var numericPart = (parseInt(idHex, 16) % 10000).toString().padStart(4, "0");
  var namePart = String(orgName || "").trim().split(/\s+/)[0].replace(/[^a-zA-Z0-9]/g, "").toUpperCase().slice(0, 10);
  return (namePart || "ORG") + "-" + numericPart;
}

function sendInviteEmail(toEmail, subject, text) {
  if (!RESEND_API_KEY) return Promise.resolve({ sent: false, reason: "no-email-service" });
  var payload = JSON.stringify({ from: EMAIL_FROM, to: [toEmail], subject: subject, text: text });
  return new Promise(function (resolve) {
    var req = https.request(
      {
        hostname: "api.resend.com",
        path: "/emails",
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Content-Length": Buffer.byteLength(payload),
          Authorization: "Bearer " + RESEND_API_KEY
        }
      },
      (res) => {
        var chunks = [];
        res.on("data", (c) => chunks.push(c));
        res.on("end", () => {
          if (res.statusCode >= 200 && res.statusCode < 300) {
            resolve({ sent: true });
          } else {
            console.error("Resend API error:", res.statusCode, Buffer.concat(chunks).toString("utf8"));
            resolve({ sent: false, reason: "provider-error" });
          }
        });
      }
    );
    req.on("error", (err) => {
      console.error("Failed to reach email provider:", err.message);
      resolve({ sent: false, reason: "network-error" });
    });
    req.write(payload);
    req.end();
  });
}

/* ---------- auth / org resolution ---------- */

async function getAdminUser(req) {
  var header = req.headers.authorization || "";
  var token = header.replace(/^Bearer\s+/i, "").trim();
  if (!token) return null;
  const { data, error } = await supabase.auth.getUser(token);
  if (error || !data || !data.user) return null;
  return data.user;
}

// Every signed-in admin owns exactly one organization, created the moment
// they pick an org type (POST /org). Before that, there's no row yet —
// callers treat that as "this admin hasn't set up their org" rather than
// an error.
async function getOrgForAdmin(user) {
  const { data: membership, error: membershipError } = await supabase
    .from("organization_members")
    .select("org_id, role, ministry_id")
    .eq("user_id", user.id)
    .limit(1)
    .maybeSingle();
  if (membershipError || !membership) return null;
  const { data, error } = await supabase.from("organizations").select("*").eq("id", membership.org_id).maybeSingle();
  if (error) { console.error("Supabase read error:", error.message); return null; }
  return data ? Object.assign(data, { membership: membership }) : null;
}

async function getMembership(userId, orgId) {
  const { data, error } = await supabase.from("organization_members")
    .select("org_id, user_id, role, ministry_id")
    .eq("org_id", orgId).eq("user_id", userId).maybeSingle();
  if (error) console.error("Supabase membership error:", error.message);
  return data || null;
}

async function getMinistries(orgId) {
  const { data, error } = await supabase.from("ministries")
    .select("id, name").eq("org_id", orgId).order("name");
  if (error) { console.error("Supabase ministries error:", error.message); return []; }
  return data || [];
}

async function getWorkerMinistry(orgId, workerId) {
  const { data } = await supabase.from("worker_ministry_memberships")
    .select("ministry_id").eq("org_id", orgId).eq("worker_id", workerId).maybeSingle();
  return data ? data.ministry_id : null;
}

async function scopeDataForMember(orgId, data, membership) {
  if (!membership || membership.role !== "ministry_leader") return data;
  const { data: memberships } = await supabase.from("worker_ministry_memberships")
    .select("worker_id").eq("org_id", orgId).eq("ministry_id", membership.ministry_id);
  var visibleIds = (memberships || []).map(function (item) { return String(item.worker_id); });
  var scoped = Object.assign({}, data);
  scoped.team = (data.team || []).filter(function (worker) { return visibleIds.indexOf(String(worker.id)) !== -1; });
  scoped.duties = Object.keys(data.duties || {}).reduce(function (result, workerId) {
    if (visibleIds.indexOf(String(workerId)) !== -1) result[workerId] = data.duties[workerId];
    return result;
  }, {});
  scoped.churchAssignments = Object.keys(data.churchAssignments || {}).reduce(function (result, duty) {
    result[duty] = Object.keys(data.churchAssignments[duty] || {}).reduce(function (services, service) {
      var workerId = data.churchAssignments[duty][service];
      if (visibleIds.indexOf(String(workerId)) !== -1) services[service] = workerId;
      return services;
    }, {});
    return result;
  }, {});
  scoped.ministries = (await getMinistries(orgId)).filter(function (ministry) {
    return String(ministry.id) === String(membership.ministry_id);
  });
  return scoped;
}

async function getOrgByInviteToken(token) {
  if (!token) return null;
  const { data: invite, error } = await supabase.from("worker_invite_tokens").select("org_id, worker_id").eq("token", token).maybeSingle();
  if (error || !invite) return null;
  const { data: org, error: orgErr } = await supabase.from("organizations").select("*").eq("id", invite.org_id).maybeSingle();
  if (orgErr || !org) return null;
  return { org: org, workerId: invite.worker_id };
}

async function saveOrg(orgId, orgData) {
  const { error } = await supabase.from("organizations").update({ data: orgData, updated_at: new Date().toISOString() }).eq("id", orgId);
  if (error) console.error("Supabase write error:", error.message);
}

function readBody(req) {
  return new Promise((resolve) => {
    if (req.body !== undefined && req.body !== null) {
      if (typeof req.body === "object") return resolve(req.body);
      try { return resolve(JSON.parse(req.body)); } catch (e) { return resolve({}); }
    }
    var chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => {
      try { resolve(chunks.length ? JSON.parse(Buffer.concat(chunks).toString("utf8")) : {}); }
      catch (e) { resolve({}); }
    });
  });
}

// Never send worker PINs (legacy field, unused once a worker has an
// invite token — kept only so local-dev-imported data doesn't break) to
// anyone. Admin-only routes get the real team array straight from Postgres.
function stripPins(team) {
  return (team || []).map(function (w) { var copy = Object.assign({}, w); delete copy.pin; return copy; });
}

module.exports = async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, DELETE, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
  if (req.method === "OPTIONS") { res.status(204).end(); return; }

  function sendJson(status, obj) { res.status(status).json(obj); }

  try {
    // vercel.json rewrites every /api/* request here as /api/router?path=<the
    // rest of the url>&<original query string>. Vanilla Vercel serverless
    // functions (unlike Next.js) don't support [...catchall] filesystem
    // routing outside of a Next.js project, so this rewrite is what actually
    // gets every sub-path to this one function.
    var pathSegments = String(req.query.path || "").split("/").filter(Boolean);
    var parts = ["api"].concat(pathSegments); // mirrors server.js's parts[1]=="workers" etc.
    var resource = parts[1];
    var inviteToken = (req.query.invite || "").toString().trim();

    /* ---------- GET /state — the one route with two shapes ----------
       An invite token, when present, always wins — it names a specific
       worker explicitly, so it takes priority over any admin session
       that happens to be signed in on the same browser (Supabase persists
       that session in localStorage independent of the URL, so without
       this a leftover/still-open admin login would hijack a worker's
       link into showing the admin's own view instead). */
    if (resource === "state" && req.method === "GET") {
      if (inviteToken) {
        var resolved = await getOrgByInviteToken(inviteToken);
        if (!resolved) return sendJson(404, { error: "That invite link isn't valid anymore — ask your admin to resend it." });
        var worker = (resolved.org.data.team || []).find((w) => w.id === resolved.workerId);
        if (!worker) return sendJson(404, { error: "That invite link isn't valid anymore — ask your admin to resend it." });
        var workerMinistryId = await getWorkerMinistry(resolved.org.id, resolved.workerId);
        var visibleTeam = (resolved.org.data.team || []).filter(function (member) {
          return String(member.id) === String(resolved.workerId) || String(member.ministryId || "") === String(workerMinistryId || "");
        });
        var workerState = Object.assign({}, resolved.org.data, {
          team: stripPins(visibleTeam),
          duties: Object.keys(resolved.org.data.duties || {}).reduce(function (result, id) {
            if (String(id) === String(resolved.workerId)) result[id] = resolved.org.data.duties[id];
            return result;
          }, {}),
          ministries: await getMinistries(resolved.org.id)
        });
        return sendJson(200, Object.assign({}, workerState, {
          currentWorkerId: resolved.workerId
        }));
      }
      var adminUser = await getAdminUser(req);
      if (adminUser) {
        var org = await getOrgForAdmin(adminUser);
        if (!org) return sendJson(200, Object.assign({}, DEFAULT_ORG_DATA, { hasOrg: false }));
        var visibleData = await scopeDataForMember(org.id, org.data, org.membership);
        return sendJson(200, Object.assign({}, org.data, {
          hasOrg: true,
          orgId: org.id,
          joinCode: shortJoinCode(org.id, org.data.orgName),
          currentRole: org.membership.role,
          currentMinistryId: org.membership.ministry_id,
          ministries: visibleData.ministries || await getMinistries(org.id),
          team: visibleData.team,
          duties: visibleData.duties,
          churchAssignments: visibleData.churchAssignments
        }));
      }
      return sendJson(401, { error: "Sign in, or use your invite link." });
    }

    /* ---------- GET /join-info — public, powers the self-serve join form.
       Deliberately minimal: just enough to render the form (what kind of
       org this is, what roles are available, its display name for
       confirmation) — never the existing roster, emails, or anything else
       about who already works there. Takes either the org's full id
       (?org=, from a join link) or its short join code (?code=, typed in
       by hand) — whichever a worker actually has on them. */
    if (resource === "join-info" && req.method === "GET") {
      var joinOrgId = (req.query.org || "").toString().trim();
      // Compared with hyphens stripped from both sides — shortJoinCode's
      // output has one ("GRACE-4821"), and a human typing it back in might
      // drop it, use a space, lowercase it, etc.
      var joinCode = (req.query.code || "").toString().trim().replace(/[^a-zA-Z0-9]/g, "").toUpperCase();
      if (!joinOrgId && !joinCode) return sendJson(400, { error: "Missing org id or code." });
      var joinOrg = null;
      if (joinOrgId) {
        const { data } = await supabase.from("organizations").select("id, data").eq("id", joinOrgId).maybeSingle();
        joinOrg = data;
      } else {
        // No schema support for looking up by code directly — org count is
        // small enough at this app's scale that scanning ids is fine.
        const { data: candidates } = await supabase.from("organizations").select("id, data").limit(2000);
        joinOrg = (candidates || []).find((o) => shortJoinCode(o.id, o.data.orgName).replace(/-/g, "") === joinCode) || null;
      }
      if (!joinOrg) return sendJson(404, { error: "That code or link isn't valid — ask your admin for a current one." });
      const { data: joinMinistries } = await supabase.from("ministries").select("id, name").eq("org_id", joinOrg.id).order("name");
      return sendJson(200, { orgId: joinOrg.id, orgType: "church", orgName: joinOrg.data.orgName, jobTypes: joinOrg.data.jobTypes, ministries: joinMinistries || [] });
    }

    // Self-serve join — no admin action needed first. Anyone with the org's
    // join link (Team tab -> "Copy join link") can add themselves; there's
    // no approval step, by design (that's what was asked for), so the
    // admin gets an activity-log entry either way to stay aware of who's
    // joined. A worker created this way is otherwise identical to one the
    // admin added by hand — same invite-token login, same everything.
    if (resource === "join" && req.method === "POST") {
      var joinBody = await readBody(req);
      var targetOrgId = String(joinBody.orgId || "").trim();
      if (!targetOrgId) return sendJson(400, { error: "Missing org id." });
      const { data: targetOrg, error: targetErr } = await supabase.from("organizations").select("*").eq("id", targetOrgId).maybeSingle();
      if (targetErr || !targetOrg) return sendJson(404, { error: "That join link isn't valid — ask your admin for a current one." });
      var joinData = targetOrg.data;
      var joinMinistryId = String(joinBody.ministryId || "").trim();
      const { data: joinMinistry } = await supabase.from("ministries").select("id").eq("id", joinMinistryId).eq("org_id", targetOrgId).maybeSingle();
      if (!joinMinistry) return sendJson(400, { error: "Choose a valid ministry." });
      var joinNextId = joinData.team.reduce((max, w) => Math.max(max, w.id), 0) + 1;
      var joinTok = crypto.randomBytes(20).toString("hex");
      var joinedWorker = {
        id: joinNextId,
        name: String(joinBody.name || "").slice(0, 80),
        role: String(joinBody.role || "").slice(0, 60),
        ministryId: joinMinistryId,
        on: false,
        email: String(joinBody.email || "").slice(0, 120),
        token: joinTok,
        invitedAt: null,
        joinedSelf: true
      };
      if (!joinedWorker.name) return sendJson(400, { error: "Name is required." });
      joinData.team.unshift(joinedWorker);
      await saveOrg(targetOrgId, joinData);
      await supabase.from("worker_invite_tokens").insert({ token: joinTok, org_id: targetOrgId, worker_id: joinNextId });
      await supabase.from("worker_ministry_memberships").upsert({ org_id: targetOrgId, worker_id: joinNextId, ministry_id: joinMinistryId });
      return sendJson(200, { worker: joinedWorker, orgType: joinData.orgType });
    }

    /* ---------- everything else needs an org, one way or another ---------- */
    var asAdmin = inviteToken ? null : await getAdminUser(req);
    var orgId, data, isAdminCaller = false, callerWorkerId = null;

    if (asAdmin) {
      var adminOrg = await getOrgForAdmin(asAdmin);
      if (resource === "org" && req.method === "POST") {
        var orgBody = await readBody(req);
        if (orgBody.orgType && orgBody.orgType !== "church") return sendJson(400, { error: "Onixora supports churches only." });
        if (!adminOrg) {
          const { data: created, error: createErr } = await supabase.from("organizations")
            .insert({ owner_id: asAdmin.id, data: Object.assign({}, DEFAULT_ORG_DATA, { orgType: "church" }) })
            .select().single();
          if (createErr) return sendJson(500, { error: createErr.message });
          const { error: memberError } = await supabase.from("organization_members")
            .insert({ org_id: created.id, user_id: asAdmin.id, role: "pastor" });
          if (memberError) return sendJson(500, { error: memberError.message });
          return sendJson(200, { orgType: "church", role: "pastor" });
        }
        adminOrg.data.orgType = "church";
        adminOrg.data.scheduleDays = null;
        adminOrg.data.jobTypes = null;
        await saveOrg(adminOrg.id, adminOrg.data);
        return sendJson(200, { orgType: "church", role: adminOrg.membership.role });
      }
      if (!adminOrg) return sendJson(400, { error: "Set up your organization first." });
      orgId = adminOrg.id;
      data = adminOrg.data;
      isAdminCaller = true;
    } else if (inviteToken) {
      var workerResolved = await getOrgByInviteToken(inviteToken);
      if (!workerResolved) return sendJson(401, { error: "That invite link isn't valid anymore — ask your admin to resend it." });
      orgId = workerResolved.org.id;
      data = workerResolved.org.data;
      callerWorkerId = workerResolved.workerId;
    } else {
      return sendJson(401, { error: "Sign in, or use your invite link." });
    }

    // Authorization is evaluated server-side for every write. The frontend
    // may hide controls, but it is never the source of permission truth.
    var membership = isAdminCaller ? await getMembership(asAdmin.id, orgId) : null;
    var role = membership && membership.role;
    var ministryId = membership && membership.ministry_id;
    function hasRole(roles) { return isAdminCaller && roles.indexOf(role) !== -1; }
    function requireRole(roles) { return hasRole(roles); }
    function canManageMinistry(targetMinistryId) {
      return hasRole(["pastor", "coordinator"]) || (role === "ministry_leader" && String(ministryId) === String(targetMinistryId));
    }
    function errorForRoles(roles) {
      return sendJson(403, { error: "This action requires " + roles.join(" or ") + " permission." });
    }

    if (isAdminCaller && !membership) return sendJson(403, { error: "You are not assigned to a church role." });

    if (resource === "ministries" && req.method === "GET") {
      if (!isAdminCaller) return sendJson(403, { error: "Church staff access required." });
      var visibleMinistries = await getMinistries(orgId);
      if (role === "ministry_leader") visibleMinistries = visibleMinistries.filter(function (ministry) { return String(ministry.id) === String(ministryId); });
      return sendJson(200, { ministries: visibleMinistries });
    }

    if (resource === "ministries" && parts.length === 2 && req.method === "POST") {
      if (!requireRole(["pastor", "coordinator"])) return errorForRoles(["Pastor", "Coordinator"]);
      var ministryBody = await readBody(req);
      var ministryName = String(ministryBody.name || "").trim().slice(0, 80);
      if (!ministryName) return sendJson(400, { error: "Ministry name is required." });
      const { data: ministry, error: ministryError } = await supabase.from("ministries")
        .insert({ org_id: orgId, name: ministryName }).select("id, name").single();
      if (ministryError) return sendJson(400, { error: ministryError.message });
      return sendJson(200, ministry);
    }

    if (resource === "ministries" && parts[3] === "leader" && req.method === "POST") {
      if (!requireRole(["pastor", "coordinator"])) return errorForRoles(["Pastor", "Coordinator"]);
      var leaderBody = await readBody(req);
      var targetMinistryId = parts[2];
      var leaderUserId = String(leaderBody.userId || "").trim();
      if (!leaderUserId) return sendJson(400, { error: "A Supabase user id is required." });
      const { data: targetMinistry } = await supabase.from("ministries").select("id").eq("id", targetMinistryId).eq("org_id", orgId).maybeSingle();
      if (!targetMinistry) return sendJson(404, { error: "Ministry not found." });
      const { data: leader, error: leaderError } = await supabase.from("organization_members")
        .upsert({ org_id: orgId, user_id: leaderUserId, role: "ministry_leader", ministry_id: targetMinistryId }, { onConflict: "org_id,user_id" })
        .select("org_id, user_id, role, ministry_id").single();
      if (leaderError) return sendJson(400, { error: leaderError.message });
      return sendJson(200, leader);
    }

    if (resource === "schedule-config" && req.method === "POST") {
      if (!requireRole(["pastor", "coordinator"])) return errorForRoles(["Pastor", "Coordinator"]);
      var scBody = await readBody(req);
      if (Array.isArray(scBody.days)) data.scheduleDays = scBody.days.map((d) => String(d).slice(0, 40)).slice(0, 14);
      if (Array.isArray(scBody.duties)) data.jobTypes = scBody.duties.map((d) => String(d).slice(0, 60)).slice(0, 40);
      await saveOrg(orgId, data);
      return sendJson(200, { scheduleDays: data.scheduleDays, jobTypes: data.jobTypes });
    }

    // Separate from POST /org on purpose — that route resets the schedule
    // setup whenever it runs (it's meant for switching org type), which a
    // simple rename shouldn't trigger.
    if (resource === "org-name" && req.method === "POST") {
      if (!requireRole(["pastor", "coordinator"])) return errorForRoles(["Pastor", "Coordinator"]);
      var nameBody = await readBody(req);
      data.orgName = String(nameBody.orgName || "").trim().slice(0, 80) || null;
      await saveOrg(orgId, data);
      return sendJson(200, { orgName: data.orgName });
    }

    if (resource === "workers" && parts.length === 2 && req.method === "POST") {
      if (!requireRole(["pastor", "coordinator", "ministry_leader"])) return errorForRoles(["Pastor", "Coordinator", "Ministry Leader"]);
      var wBody = await readBody(req);
      var workerMinistryId = String(wBody.ministryId || (role === "ministry_leader" ? ministryId : "")).trim();
      if (!workerMinistryId) return sendJson(400, { error: "Assign this worker to a ministry." });
      if (!canManageMinistry(workerMinistryId)) return sendJson(403, { error: "You can only manage workers in your ministry." });
      const { data: workerMinistry } = await supabase.from("ministries").select("id").eq("id", workerMinistryId).eq("org_id", orgId).maybeSingle();
      if (!workerMinistry) return sendJson(404, { error: "Ministry not found." });
      var nextId = data.team.reduce((max, w) => Math.max(max, w.id), 0) + 1;
      var inviteTok = crypto.randomBytes(20).toString("hex");
      var newWorker = {
        id: nextId,
        name: String(wBody.name || "").slice(0, 80),
        role: String(wBody.role || "").slice(0, 60),
        on: wBody.status === "on",
        email: String(wBody.email || "").slice(0, 120),
        ministryId: workerMinistryId,
        token: inviteTok,
        invitedAt: null
      };
      data.team.unshift(newWorker);
      await saveOrg(orgId, data);
      await supabase.from("worker_invite_tokens").insert({ token: inviteTok, org_id: orgId, worker_id: nextId });
      await supabase.from("worker_ministry_memberships").upsert({ org_id: orgId, worker_id: nextId, ministry_id: workerMinistryId });
      return sendJson(200, newWorker);
    }

    if (resource === "workers" && parts[3] === "invite" && req.method === "POST") {
      if (!requireRole(["pastor", "coordinator", "ministry_leader"])) return errorForRoles(["Pastor", "Coordinator", "Ministry Leader"]);
      var inviteWorkerId = Number(parts[2]);
      var inviteWorker = data.team.find((w) => w.id === inviteWorkerId);
      if (!inviteWorker) return sendJson(404, { error: "not found" });
      if (!canManageMinistry(await getWorkerMinistry(orgId, inviteWorkerId))) return sendJson(403, { error: "You can only manage workers in your ministry." });
      if (!inviteWorker.email) return sendJson(400, { sent: false, reason: "no-email-on-file" });

      var appUrl = req.headers.origin || ("https://" + req.headers.host);
      var inviteLink = appUrl + "/?invite=" + inviteWorker.token;
      var subject = "Your Onixora sign-in";
      var text = "You're on the Onixora schedule as " + inviteWorker.name + " (" + inviteWorker.role + ").\n" +
        "Open your personal link to see your shifts and clock in: " + inviteLink;

      var result = await sendInviteEmail(inviteWorker.email, subject, text);
      if (result.sent) {
        inviteWorker.invitedAt = new Date().toISOString();
        await saveOrg(orgId, data);
      }
      return sendJson(200, { sent: result.sent, reason: result.reason || null, worker: inviteWorker });
    }

    if (resource === "workers" && parts[3] === "mark-invited" && req.method === "POST") {
      if (!requireRole(["pastor", "coordinator", "ministry_leader"])) return errorForRoles(["Pastor", "Coordinator", "Ministry Leader"]);
      var markWorkerId = Number(parts[2]);
      var markWorker = data.team.find((w) => w.id === markWorkerId);
      if (!markWorker) return sendJson(404, { error: "not found" });
      if (!canManageMinistry(await getWorkerMinistry(orgId, markWorkerId))) return sendJson(403, { error: "You can only manage workers in your ministry." });
      markWorker.invitedAt = new Date().toISOString();
      await saveOrg(orgId, data);
      return sendJson(200, markWorker);
    }

    if (resource === "workers" && parts[3] === "status" && req.method === "POST") {
      if (!requireRole(["pastor", "coordinator", "ministry_leader"])) return errorForRoles(["Pastor", "Coordinator", "Ministry Leader"]);
      var statusBody = await readBody(req);
      var statusWorkerId = Number(parts[2]);
      var statusWorker = data.team.find((w) => w.id === statusWorkerId);
      if (!statusWorker) return sendJson(404, { error: "not found" });
      if (!canManageMinistry(await getWorkerMinistry(orgId, statusWorkerId))) return sendJson(403, { error: "You can only manage workers in your ministry." });
      statusWorker.on = statusBody.status === "on";
      await saveOrg(orgId, data);
      return sendJson(200, statusWorker);
    }

    if (resource === "workers" && req.method === "DELETE") {
      if (!requireRole(["pastor", "coordinator", "ministry_leader"])) return errorForRoles(["Pastor", "Coordinator", "Ministry Leader"]);
      var delId = Number(parts[2]);
      if (!canManageMinistry(await getWorkerMinistry(orgId, delId))) return sendJson(403, { error: "You can only manage workers in your ministry." });
      data.team = data.team.filter((w) => w.id !== delId);
      delete data.duties[delId];
      Object.keys(data.churchAssignments || {}).forEach(function (duty) {
        Object.keys(data.churchAssignments[duty] || {}).forEach(function (service) {
          if (String(data.churchAssignments[duty][service]) === String(delId)) data.churchAssignments[duty][service] = "";
        });
      });
      await saveOrg(orgId, data);
      await supabase.from("worker_invite_tokens").delete().eq("org_id", orgId).eq("worker_id", delId);
      await supabase.from("worker_ministry_memberships").delete().eq("org_id", orgId).eq("worker_id", delId);
      return sendJson(200, { removed: delId });
    }

    if (resource === "duties" && req.method === "POST") {
      if (!requireRole(["pastor", "coordinator", "ministry_leader"])) return errorForRoles(["Pastor", "Coordinator", "Ministry Leader"]);
      var dBody = await readBody(req);
      if (!canManageMinistry(await getWorkerMinistry(orgId, dBody.workerId))) return sendJson(403, { error: "You can only assign duties within your ministry." });
      if (!data.duties[dBody.workerId]) data.duties[dBody.workerId] = {};
      data.duties[dBody.workerId][dBody.day] = dBody.duty;
      await saveOrg(orgId, data);
      return sendJson(200, dBody);
    }

    if (resource === "church-assignments" && req.method === "POST") {
      if (!requireRole(["pastor", "coordinator", "ministry_leader"])) return errorForRoles(["Pastor", "Coordinator", "Ministry Leader"]);
      var caBody = await readBody(req);
      if (role === "ministry_leader" && !canManageMinistry(await getWorkerMinistry(orgId, caBody.workerId))) return sendJson(403, { error: "You can only schedule workers within your ministry." });
      if (!data.churchAssignments) data.churchAssignments = {};
      if (!data.churchAssignments[caBody.duty]) data.churchAssignments[caBody.duty] = {};
      data.churchAssignments[caBody.duty][caBody.service] = caBody.workerId;
      await saveOrg(orgId, data);
      return sendJson(200, caBody);
    }

    if (resource === "announcements" && req.method === "POST") {
      if (!requireRole(["pastor", "coordinator"])) return errorForRoles(["Pastor", "Coordinator"]);
      var anBody = await readBody(req);
      if (!Array.isArray(data.announcements)) data.announcements = [];
      data.announcements.unshift(anBody);
      await saveOrg(orgId, data);
      return sendJson(200, anBody);
    }

    // Workers create their own swap requests; only admins resolve them.
    if (resource === "swaps" && parts.length === 2 && req.method === "POST") {
      var newSwapBody = await readBody(req);
      if (!isAdminCaller) {
        var callerWorker = data.team.find(function (worker) { return String(worker.id) === String(callerWorkerId); });
        if (!callerWorker) return sendJson(403, { error: "Worker identity not found." });
        newSwapBody.from = callerWorker.name;
      }
      var nextSwapId = data.swaps.reduce((max, s) => Math.max(max, s.id || 0), 0) + 1;
      var newSwap = {
        id: nextSwapId,
        from: String(newSwapBody.from || "").slice(0, 80),
        fromShift: String(newSwapBody.fromShift || "").slice(0, 120),
        to: String(newSwapBody.to || "").slice(0, 80),
        toShift: String(newSwapBody.toShift || "").slice(0, 120),
        status: "pending"
      };
      data.swaps.unshift(newSwap);
      await saveOrg(orgId, data);
      return sendJson(200, newSwap);
    }

    if (resource === "swaps" && parts.length === 3 && req.method === "POST") {
      if (!requireRole(["pastor", "coordinator", "ministry_leader"])) return errorForRoles(["Pastor", "Coordinator", "Ministry Leader"]);
      var sBody = await readBody(req);
      var swapId = Number(parts[2]);
      var swap = data.swaps.find((s) => s.id === swapId);
      if (!swap) return sendJson(404, { error: "not found" });
      swap.status = sBody.status;
      await saveOrg(orgId, data);
      return sendJson(200, swap);
    }

    // Workers clock themselves in/out; nothing admin-only about it.
    if (resource === "attendance" && req.method === "POST") {
      if (parts[2]) {
        var updateAttendanceBody = await readBody(req);
        var attendanceId = String(parts[2]);
        var attendanceEntry = (data.attendance || []).find(function (entry) { return String(entry.id || "") === attendanceId; });
        if (!attendanceEntry) return sendJson(404, { error: "attendance entry not found" });
        Object.assign(attendanceEntry, updateAttendanceBody, { id: attendanceEntry.id });
        await saveOrg(orgId, data);
        return sendJson(200, attendanceEntry);
      }
      var aBody = await readBody(req);
      if (!isAdminCaller) {
        var attendanceWorker = data.team.find(function (worker) { return String(worker.id) === String(callerWorkerId); });
        if (!attendanceWorker) return sendJson(403, { error: "Worker identity not found." });
        aBody.name = attendanceWorker.name;
        aBody.role = attendanceWorker.role;
      }
      data.attendance.unshift(aBody);
      await saveOrg(orgId, data);
      return sendJson(200, aBody);
    }

    // Chat media (photos/videos): the client uploads the actual file bytes
    // straight to Supabase Storage using the signed URL this hands back —
    // never through this function — so a phone video doesn't have to fit
    // inside a serverless function's request body limit. The signed token
    // is itself the one-time authorization, scoped to this exact path
    // (<orgId>/<random>-<filename>), so this works the same for an
    // unauthenticated worker (invite token) as it does for an admin.
    if (resource === "chat-media-upload-url" && req.method === "POST") {
      var mediaBody = await readBody(req);
      var rawName = String(mediaBody.filename || "file").replace(/[^a-zA-Z0-9_.-]/g, "_").slice(-80);
      var mediaPath = orgId + "/" + crypto.randomBytes(8).toString("hex") + "-" + rawName;
      const { data: signed, error: signErr } = await supabase.storage.from("chat-media").createSignedUploadUrl(mediaPath);
      if (signErr) return sendJson(500, { error: signErr.message });
      const { data: pub } = supabase.storage.from("chat-media").getPublicUrl(mediaPath);
      return sendJson(200, { path: mediaPath, token: signed.token, publicUrl: pub.publicUrl });
    }

    // Deleting a message: an admin can remove anything; a worker can only
    // remove their own (matched by authorKey against the invite token that
    // resolved this request — workers have no login of their own to check
    // against, so the token standing in for "who is this" is what's used).
    // Must be checked before the plain POST /chat/:channel route below,
    // which has no guard on parts[3] and would otherwise swallow this as
    // "post a new message to channel 'general' with a stray /delete after
    // it" — silently accepting the request while doing nothing but append
    // whatever body came with it, instead of ever deleting the message.
    if (resource === "chat" && parts[3] === "delete" && req.method === "POST") {
      var delChannel = parts[2];
      var delBody = await readBody(req);
      var msgs = data.chat[delChannel] || [];
      var target = msgs.find((m) => m.id === delBody.id);
      if (!target) return sendJson(404, { error: "not found" });
      var ownsIt = isAdminCaller ? target.authorKey === "admin" : target.authorKey === String(callerWorkerId);
      if (!isAdminCaller && !ownsIt) return sendJson(403, { error: "You can only delete your own messages." });
      data.chat[delChannel] = msgs.filter((m) => m.id !== delBody.id);
      await saveOrg(orgId, data);
      return sendJson(200, { removed: delBody.id });
    }

    // Shared channel — both admin and worker post here.
    if (resource === "chat" && req.method === "POST") {
      var channel = parts[2];
      var cBody = await readBody(req);
      if (!data.chat[channel]) data.chat[channel] = [];
      data.chat[channel].push(cBody);
      await saveOrg(orgId, data);
      return sendJson(200, cBody);
    }

    return sendJson(404, { error: "unknown endpoint" });
  } catch (err) {
    console.error("API error:", err);
    return sendJson(500, { error: String(err && err.message || err) });
  }
};
