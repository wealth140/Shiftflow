/* ================================================
   ShiftFlow — production API (Vercel + Supabase)

   This is the "real deployment" twin of server.js. Same routes, same
   behavior — but Vercel's filesystem is read-only/ephemeral, so instead
   of writing to a local data.json file, this persists to a Supabase
   (Postgres) table. Local development still uses server.js + data.json;
   nothing about running `node server.js` on your own machine changes.

   Requires two environment variables set on the Vercel project:
     SUPABASE_URL          — your Supabase project URL
     SUPABASE_SERVICE_KEY  — the project's service_role key (server-side
                              only secret — never expose this to the
                              browser; Vercel env vars aren't sent to the
                              client unless you prefix them NEXT_PUBLIC_/
                              VITE_, which we don't, so this is safe)
   Optional, for real invite emails (same as server.js):
     RESEND_API_KEY, EMAIL_FROM

   One-time setup: run the SQL in README.md ("Deploying for real") against
   your Supabase project before the first request.
   ================================================ */
const { createClient } = require("@supabase/supabase-js");
const https = require("https");

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);
const STATE_ROW_ID = "default";

const RESEND_API_KEY = process.env.RESEND_API_KEY || "";
const EMAIL_FROM = process.env.EMAIL_FROM || "ShiftFlow <onboarding@resend.dev>";

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

var DEFAULT_STATE = {
  orgType: null, team: [], duties: {}, churchAssignments: {}, swaps: [],
  attendance: [], chat: { general: [], schedule: [], announcements: [] }, announcements: [],
  scheduleDays: null, jobTypes: null
};

async function readData() {
  const { data, error } = await supabase.from("app_state").select("data").eq("id", STATE_ROW_ID).maybeSingle();
  if (error) {
    console.error("Supabase read error:", error.message);
    return JSON.parse(JSON.stringify(DEFAULT_STATE));
  }
  if (!data) {
    await writeData(DEFAULT_STATE);
    return JSON.parse(JSON.stringify(DEFAULT_STATE));
  }
  return data.data;
}

async function writeData(state) {
  const { error } = await supabase.from("app_state").upsert({ id: STATE_ROW_ID, data: state, updated_at: new Date().toISOString() });
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

module.exports = async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, DELETE, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  if (req.method === "OPTIONS") { res.status(204).end(); return; }

  function sendJson(status, obj) { res.status(status).json(obj); }

  try {
    var rawParts = req.query.path || [];
    var parts = ["api"].concat(Array.isArray(rawParts) ? rawParts : [rawParts]); // mirrors server.js's parts[1]=="workers" etc.
    var resource = parts[1];
    var data = await readData();

    if (resource === "state" && req.method === "GET") {
      return sendJson(200, data);
    }

    if (resource === "org" && req.method === "POST") {
      var orgBody = await readBody(req);
      data.orgType = orgBody.orgType;
      data.scheduleDays = null;
      data.jobTypes = null;
      await writeData(data);
      return sendJson(200, { orgType: data.orgType });
    }

    if (resource === "schedule-config" && req.method === "POST") {
      var scBody = await readBody(req);
      if (Array.isArray(scBody.days)) {
        data.scheduleDays = scBody.days.map((d) => String(d).slice(0, 40)).slice(0, 14);
      }
      if (Array.isArray(scBody.duties)) {
        data.jobTypes = scBody.duties.map((d) => String(d).slice(0, 60)).slice(0, 40);
      }
      await writeData(data);
      return sendJson(200, { scheduleDays: data.scheduleDays, jobTypes: data.jobTypes });
    }

    if (resource === "workers" && parts.length === 2 && req.method === "POST") {
      var wBody = await readBody(req);
      var nextId = data.team.reduce((max, w) => Math.max(max, w.id), 0) + 1;
      var worker = {
        id: nextId,
        name: String(wBody.name || "").slice(0, 80),
        role: String(wBody.role || "").slice(0, 60),
        on: wBody.status === "on",
        email: String(wBody.email || "").slice(0, 120),
        pin: String(wBody.pin || "").slice(0, 8),
        invitedAt: null
      };
      data.team.unshift(worker);
      await writeData(data);
      return sendJson(200, worker);
    }

    if (resource === "workers" && parts[3] === "invite" && req.method === "POST") {
      var inviteWorkerId = Number(parts[2]);
      var inviteWorker = data.team.find((w) => w.id === inviteWorkerId);
      if (!inviteWorker) return sendJson(404, { error: "not found" });
      if (!inviteWorker.email) return sendJson(400, { sent: false, reason: "no-email-on-file" });

      var appUrl = req.headers.origin || ("https://" + req.headers.host);
      var subject = "Your ShiftFlow sign-in";
      var text = "You're on the ShiftFlow schedule as " + inviteWorker.name + " (" + inviteWorker.role + ").\n" +
        "Open " + appUrl + ", choose \"I'm a worker,\" pick your name (or enter your email), and sign in with this PIN: " + inviteWorker.pin;

      var result = await sendInviteEmail(inviteWorker.email, subject, text);
      if (result.sent) {
        inviteWorker.invitedAt = new Date().toISOString();
        await writeData(data);
      }
      return sendJson(200, { sent: result.sent, reason: result.reason || null, worker: inviteWorker });
    }

    if (resource === "workers" && parts[3] === "mark-invited" && req.method === "POST") {
      var markWorkerId = Number(parts[2]);
      var markWorker = data.team.find((w) => w.id === markWorkerId);
      if (!markWorker) return sendJson(404, { error: "not found" });
      markWorker.invitedAt = new Date().toISOString();
      await writeData(data);
      return sendJson(200, markWorker);
    }

    if (resource === "workers" && parts[3] === "status" && req.method === "POST") {
      var statusBody = await readBody(req);
      var statusWorkerId = Number(parts[2]);
      var statusWorker = data.team.find((w) => w.id === statusWorkerId);
      if (!statusWorker) return sendJson(404, { error: "not found" });
      statusWorker.on = statusBody.status === "on";
      await writeData(data);
      return sendJson(200, statusWorker);
    }

    if (resource === "workers" && parts[3] === "pin" && req.method === "POST") {
      var pinBody = await readBody(req);
      var pinWorkerId = Number(parts[2]);
      var pinWorker = data.team.find((w) => w.id === pinWorkerId);
      if (!pinWorker) return sendJson(404, { error: "not found" });
      pinWorker.pin = String(pinBody.pin || "").slice(0, 8);
      await writeData(data);
      return sendJson(200, pinWorker);
    }

    if (resource === "workers" && req.method === "DELETE") {
      var delId = Number(parts[2]);
      data.team = data.team.filter((w) => w.id !== delId);
      delete data.duties[delId];
      await writeData(data);
      return sendJson(200, { removed: delId });
    }

    if (resource === "duties" && req.method === "POST") {
      var dBody = await readBody(req);
      if (!data.duties[dBody.workerId]) data.duties[dBody.workerId] = {};
      data.duties[dBody.workerId][dBody.day] = dBody.duty;
      await writeData(data);
      return sendJson(200, dBody);
    }

    if (resource === "church-assignments" && req.method === "POST") {
      var caBody = await readBody(req);
      if (!data.churchAssignments) data.churchAssignments = {};
      if (!data.churchAssignments[caBody.duty]) data.churchAssignments[caBody.duty] = {};
      data.churchAssignments[caBody.duty][caBody.service] = caBody.workerId;
      await writeData(data);
      return sendJson(200, caBody);
    }

    if (resource === "announcements" && req.method === "POST") {
      var anBody = await readBody(req);
      if (!Array.isArray(data.announcements)) data.announcements = [];
      data.announcements.unshift(anBody);
      await writeData(data);
      return sendJson(200, anBody);
    }

    if (resource === "swaps" && parts.length === 2 && req.method === "POST") {
      var newSwapBody = await readBody(req);
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
      await writeData(data);
      return sendJson(200, newSwap);
    }

    if (resource === "swaps" && parts.length === 3 && req.method === "POST") {
      var sBody = await readBody(req);
      var swapId = Number(parts[2]);
      var swap = data.swaps.find((s) => s.id === swapId);
      if (!swap) return sendJson(404, { error: "not found" });
      swap.status = sBody.status;
      await writeData(data);
      return sendJson(200, swap);
    }

    if (resource === "attendance" && req.method === "POST") {
      var aBody = await readBody(req);
      data.attendance.unshift(aBody);
      await writeData(data);
      return sendJson(200, aBody);
    }

    if (resource === "chat" && req.method === "POST") {
      var channel = parts[2];
      var cBody = await readBody(req);
      if (!data.chat[channel]) data.chat[channel] = [];
      data.chat[channel].push(cBody);
      await writeData(data);
      return sendJson(200, cBody);
    }

    return sendJson(404, { error: "unknown endpoint" });
  } catch (err) {
    console.error("API error:", err);
    return sendJson(500, { error: String(err && err.message || err) });
  }
};
