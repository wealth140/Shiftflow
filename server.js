/* ================================================
   ShiftFlow — backend server
   Zero dependencies — just Node's built-in http/fs.
   Run with:  node server.js
   Then open: http://localhost:3000

   Serves the frontend files and a small REST API,
   persisting everything to data.json on disk so it
   survives restarts.
   ================================================ */
const http = require("http");
const https = require("https");
const fs = require("fs");
const path = require("path");
const url = require("url");

const PORT = process.env.PORT || 3000;
const ROOT = __dirname;
const DATA_FILE = path.join(ROOT, "data.json");

// Real invite emails only go out if RESEND_API_KEY is set on the deployed
// server (https://resend.com — free tier, no dependency needed since we
// just POST to their REST API with Node's built-in https module). Without
// it, the "Email invite" button falls back to opening the admin's own mail
// client (see emailInvite() in script.js) — the app still works with zero
// configuration, real delivery is opt-in once you deploy.
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

const STATIC_TYPES = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8"
};

/* ---------- storage helpers ---------- */
var DEFAULT_STATE = {
  orgType: null, team: [], duties: {}, churchAssignments: {}, swaps: [],
  attendance: [], chat: { general: [], schedule: [], announcements: [] }, announcements: [],
  scheduleDays: null, jobTypes: null
};
function readData() {
  try {
    return JSON.parse(fs.readFileSync(DATA_FILE, "utf8"));
  } catch (err) {
    // Missing or corrupt data.json — don't crash the server, start fresh.
    console.warn("data.json missing or invalid, starting from an empty state:", err.message);
    writeData(DEFAULT_STATE);
    return JSON.parse(JSON.stringify(DEFAULT_STATE));
  }
}
function writeData(data) {
  try {
    fs.writeFileSync(DATA_FILE, JSON.stringify(data, null, 2));
  } catch (err) {
    console.error("Failed to write data.json:", err.message);
  }
}

/* ---------- request body helper ---------- */
function readBody(req) {
  return new Promise((resolve) => {
    var chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => {
      try {
        resolve(chunks.length ? JSON.parse(Buffer.concat(chunks).toString("utf8")) : {});
      } catch (e) {
        resolve({});
      }
    });
  });
}
function sendJson(res, status, obj) {
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(obj));
}

/* ---------- static file serving ---------- */
function serveStatic(req, res, pathname) {
  var filePath = pathname === "/" ? "/index.html" : pathname;
  var fullPath = path.join(ROOT, filePath);
  if (!fullPath.startsWith(ROOT)) { res.writeHead(403); return res.end("Forbidden"); }
  fs.readFile(fullPath, (err, content) => {
    if (err) { res.writeHead(404); return res.end("Not found"); }
    var ext = path.extname(fullPath);
    res.writeHead(200, { "Content-Type": STATIC_TYPES[ext] || "application/octet-stream" });
    res.end(content);
  });
}

/* ---------- API routing ---------- */
async function handleApi(req, res, pathname) {
  var parts = pathname.split("/").filter(Boolean); // ["api", "workers", "3"]
  var resource = parts[1];
  var data = readData();

  if (resource === "state" && req.method === "GET") {
    return sendJson(res, 200, data);
  }

  if (resource === "org" && req.method === "POST") {
    var orgBody = await readBody(req);
    data.orgType = orgBody.orgType;
    // A new org type means a different set of days/services and job types
    // are meaningful — any custom schedule setup from before belongs to
    // the old org type, so start that part fresh too.
    data.scheduleDays = null;
    data.jobTypes = null;
    writeData(data);
    return sendJson(res, 200, { orgType: data.orgType });
  }

  if (resource === "schedule-config" && req.method === "POST") {
    var scBody = await readBody(req);
    if (Array.isArray(scBody.days)) {
      data.scheduleDays = scBody.days.map((d) => String(d).slice(0, 40)).slice(0, 14);
    }
    if (Array.isArray(scBody.duties)) {
      data.jobTypes = scBody.duties.map((d) => String(d).slice(0, 60)).slice(0, 40);
    }
    writeData(data);
    return sendJson(res, 200, { scheduleDays: data.scheduleDays, jobTypes: data.jobTypes });
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
    writeData(data);
    return sendJson(res, 200, worker);
  }

  if (resource === "workers" && parts[3] === "invite" && req.method === "POST") {
    var inviteWorkerId = Number(parts[2]);
    var inviteWorker = data.team.find((w) => w.id === inviteWorkerId);
    if (!inviteWorker) return sendJson(res, 404, { error: "not found" });
    if (!inviteWorker.email) return sendJson(res, 400, { sent: false, reason: "no-email-on-file" });

    var appUrl = (req.headers.origin) || ("http://" + req.headers.host);
    var subject = "Your ShiftFlow sign-in";
    var text = "You're on the ShiftFlow schedule as " + inviteWorker.name + " (" + inviteWorker.role + ").\n" +
      "Open " + appUrl + ", choose \"I'm a worker,\" pick your name (or enter your email), and sign in with this PIN: " + inviteWorker.pin;

    var result = await sendInviteEmail(inviteWorker.email, subject, text);
    if (result.sent) {
      inviteWorker.invitedAt = new Date().toISOString();
      writeData(data);
    }
    return sendJson(res, 200, { sent: result.sent, reason: result.reason || null, worker: inviteWorker });
  }

  if (resource === "workers" && parts[3] === "mark-invited" && req.method === "POST") {
    var markWorkerId = Number(parts[2]);
    var markWorker = data.team.find((w) => w.id === markWorkerId);
    if (!markWorker) return sendJson(res, 404, { error: "not found" });
    markWorker.invitedAt = new Date().toISOString();
    writeData(data);
    return sendJson(res, 200, markWorker);
  }

  if (resource === "workers" && parts[3] === "status" && req.method === "POST") {
    var statusBody = await readBody(req);
    var statusWorkerId = Number(parts[2]);
    var statusWorker = data.team.find((w) => w.id === statusWorkerId);
    if (!statusWorker) return sendJson(res, 404, { error: "not found" });
    statusWorker.on = statusBody.status === "on";
    writeData(data);
    return sendJson(res, 200, statusWorker);
  }

  if (resource === "workers" && parts[3] === "pin" && req.method === "POST") {
    var pinBody = await readBody(req);
    var pinWorkerId = Number(parts[2]);
    var pinWorker = data.team.find((w) => w.id === pinWorkerId);
    if (!pinWorker) return sendJson(res, 404, { error: "not found" });
    pinWorker.pin = String(pinBody.pin || "").slice(0, 8);
    writeData(data);
    return sendJson(res, 200, pinWorker);
  }

  if (resource === "workers" && req.method === "DELETE") {
    var delId = Number(parts[2]);
    data.team = data.team.filter((w) => w.id !== delId);
    delete data.duties[delId];
    writeData(data);
    return sendJson(res, 200, { removed: delId });
  }

  if (resource === "duties" && req.method === "POST") {
    var dBody = await readBody(req);
    if (!data.duties[dBody.workerId]) data.duties[dBody.workerId] = {};
    data.duties[dBody.workerId][dBody.day] = dBody.duty;
    writeData(data);
    return sendJson(res, 200, dBody);
  }

  if (resource === "church-assignments" && req.method === "POST") {
    var caBody = await readBody(req);
    if (!data.churchAssignments) data.churchAssignments = {};
    if (!data.churchAssignments[caBody.duty]) data.churchAssignments[caBody.duty] = {};
    data.churchAssignments[caBody.duty][caBody.service] = caBody.workerId;
    writeData(data);
    return sendJson(res, 200, caBody);
  }

  if (resource === "announcements" && req.method === "POST") {
    var anBody = await readBody(req);
    if (!Array.isArray(data.announcements)) data.announcements = [];
    data.announcements.unshift(anBody);
    writeData(data);
    return sendJson(res, 200, anBody);
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
    writeData(data);
    return sendJson(res, 200, newSwap);
  }

  if (resource === "swaps" && parts.length === 3 && req.method === "POST") {
    var sBody = await readBody(req);
    var swapId = Number(parts[2]);
    var swap = data.swaps.find((s) => s.id === swapId);
    if (!swap) return sendJson(res, 404, { error: "not found" });
    swap.status = sBody.status;
    writeData(data);
    return sendJson(res, 200, swap);
  }

  if (resource === "attendance" && req.method === "POST") {
    var aBody = await readBody(req);
    data.attendance.unshift(aBody);
    writeData(data);
    return sendJson(res, 200, aBody);
  }

  if (resource === "chat" && req.method === "POST") {
    var channel = parts[2];
    var cBody = await readBody(req);
    if (!data.chat[channel]) data.chat[channel] = [];
    data.chat[channel].push(cBody);
    writeData(data);
    return sendJson(res, 200, cBody);
  }

  sendJson(res, 404, { error: "unknown endpoint" });
}

/* ---------- server ---------- */
// CORS: allows the frontend to be hosted separately from this backend
// (e.g. static files on GitHub Pages, API here on a Node host) without
// every fetch() silently failing. Since this is a small internal tool
// with its own PIN-based worker gate rather than real auth, allowing any
// origin is a reasonable tradeoff for "it just works" — tighten this to
// a specific origin if that ever matters for your deployment.
function setCorsHeaders(res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, DELETE, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
}

const server = http.createServer((req, res) => {
  setCorsHeaders(res);
  if (req.method === "OPTIONS") {
    res.writeHead(204);
    return res.end();
  }

  var parsed = url.parse(req.url);
  var pathname = decodeURIComponent(parsed.pathname);

  if (pathname.startsWith("/api/")) {
    handleApi(req, res, pathname).catch((err) => {
      sendJson(res, 500, { error: String(err) });
    });
  } else if (req.method === "GET") {
    serveStatic(req, res, pathname);
  } else {
    res.writeHead(405);
    res.end("Method not allowed");
  }
});

server.listen(PORT, () => {
  console.log("ShiftFlow backend running at http://localhost:" + PORT);
});
