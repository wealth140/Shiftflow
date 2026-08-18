/* ================================================
   ShiftFlow — app logic (vanilla JS, no dependencies)
   State starts empty — you build the roster and
   schedule yourself. Backend data (if server.js is
   running) is the source of truth; otherwise state
   lives in memory for this session only.
   ================================================ */
(function () {
  "use strict";

  // Defensive fallback: if api.js failed to load for any reason, don't let
  // the whole app break — every ShiftFlowAPI call already treats a null/
  // rejected response as "no backend", so a set of no-op resolvers is safe.
  if (typeof window.ShiftFlowAPI === "undefined") {
    var noop = function () { return Promise.resolve(null); };
    window.ShiftFlowAPI = {
      checkBackend: function () { return Promise.resolve(false); },
      getState: noop, setOrg: noop, addWorker: noop, removeWorker: noop,
      setDuty: noop, setChurchAssignment: noop, resolveSwap: noop,
      logAttendance: noop, postChatMessage: noop, addAnnouncement: noop
    };
  }
  var ShiftFlowAPI = window.ShiftFlowAPI;

  /* ---------------------------------------------
     Utilities
  --------------------------------------------- */
  function $(sel, ctx) { return (ctx || document).querySelector(sel); }
  function $all(sel, ctx) { return Array.prototype.slice.call((ctx || document).querySelectorAll(sel)); }
  function el(tag, className, html) {
    var node = document.createElement(tag);
    if (className) node.className = className;
    if (html !== undefined) node.innerHTML = html;
    return node;
  }
  function timeNow() {
    var d = new Date();
    var h = d.getHours(), m = d.getMinutes();
    var ampm = h >= 12 ? "PM" : "AM";
    h = h % 12; if (h === 0) h = 12;
    return h + ":" + (m < 10 ? "0" : "") + m + " " + ampm;
  }
  function escapeHtml(str) {
    var div = document.createElement("div");
    div.textContent = str;
    return div.innerHTML;
  }
  function initials(name) {
    return name.split(" ").map(function (p) { return p[0]; }).join("").slice(0, 2).toUpperCase();
  }
  var reduceMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;

  /* ---------------------------------------------
     Theme toggle (light/dark)
     The blocking script in <head> already applied the saved/system
     preference before paint, so this just wires up the button and
     keeps it in sync as views change (it needs a light-surface style
     while looking at the admin/worker app in light mode, vs the
     always-dark gates).
  --------------------------------------------- */
  var themeToggle = $("#themeToggle");
  function currentTheme() { return document.documentElement.getAttribute("data-theme") === "dark" ? "dark" : "light"; }
  function setTheme(theme) {
    if (theme === "dark") document.documentElement.setAttribute("data-theme", "dark");
    else document.documentElement.removeAttribute("data-theme");
    if (themeToggle) themeToggle.setAttribute("aria-pressed", theme === "dark" ? "true" : "false");
    try { localStorage.setItem("shiftflow-theme", theme); } catch (e) { /* storage blocked — theme still applies for this session */ }
    updateToggleSurface();
  }
  function updateToggleSurface() {
    if (!themeToggle) return;
    var onLightAppView = currentTheme() === "light" && (!appEl.hidden || !workerShell.hidden);
    themeToggle.classList.toggle("is-on-light-surface", !!onLightAppView);
  }
  if (themeToggle) {
    themeToggle.setAttribute("aria-pressed", currentTheme() === "dark" ? "true" : "false");
    themeToggle.addEventListener("click", function () { setTheme(currentTheme() === "dark" ? "light" : "dark"); });
  }


  /* ---------------------------------------------
     Toast
  --------------------------------------------- */
  var toastHost = el("div");
  toastHost.style.cssText = "position:fixed;bottom:26px;left:50%;transform:translateX(-50%);z-index:90;display:flex;flex-direction:column;gap:8px;align-items:center;";
  document.body.appendChild(toastHost);
  function showToast(message, isError) {
    var t = el("div", "", message);
    var bg = isError ? "var(--coral)" : "var(--brand-ink)";
    t.style.cssText = "background:" + bg + ";color:#fff;padding:11px 20px;border-radius:999px;font-size:0.84rem;box-shadow:0 14px 30px -10px rgba(18,32,61,0.5);opacity:0;transform:translateY(8px);transition:opacity .2s ease, transform .2s ease;max-width:88vw;text-align:center;";
    toastHost.appendChild(t);
    requestAnimationFrame(function () { t.style.opacity = "1"; t.style.transform = "translateY(0)"; });
    window.setTimeout(function () {
      t.style.opacity = "0"; t.style.transform = "translateY(8px)";
      window.setTimeout(function () { t.remove(); }, 220);
    }, 2600);
  }

  /* ---------------------------------------------
     0. Organization type — gate + terminology + structure
     Each org type defines its own *structure*, not just labels:
     "grid" mode = a per-worker, per-day duty table (most business
     types). "church" mode = a per-service, per-ministry-duty table,
     because a church's week revolves around Sunday services rather
     than a uniform daily shift grid.
  --------------------------------------------- */
  var ORG_TYPES = {
    business:   { label: "Business",        icon: "briefcase", mode: "grid",   days: ["Mon","Tue","Wed","Thu","Fri","Sat","Sun"], duties: ["Front Desk", "Kitchen", "Floor", "Security", "Warehouse"] },
    church:     { label: "Church",           icon: "church",    mode: "church", services: ["First Service", "Second Service", "Youth Service", "Midweek Service"], duties: ["Usher", "Greeter", "Choir", "Media & Sound", "Parking Team", "Children's Ministry", "Security"] },
    hospital:   { label: "Hospital",         icon: "pulse",     mode: "grid",   days: ["Mon","Tue","Wed","Thu","Fri","Sat","Sun"], duties: ["Nursing", "Reception", "Security", "Housekeeping", "Lab"] },
    school:     { label: "School",           icon: "book",      mode: "grid",   days: ["Mon","Tue","Wed","Thu","Fri"], duties: ["Front Office", "Cafeteria", "Security", "Custodial", "Bus Duty"] },
    hotel:      { label: "Hotel",            icon: "bed",       mode: "grid",   days: ["Mon","Tue","Wed","Thu","Fri","Sat","Sun"], duties: ["Front Desk", "Housekeeping", "Kitchen", "Security", "Concierge"] },
    restaurant: { label: "Restaurant",       icon: "utensils",  mode: "grid",   days: ["Mon","Tue","Wed","Thu","Fri","Sat","Sun"], duties: ["Host", "Kitchen", "Server", "Bar", "Dish"] },
    security:   { label: "Security Company", icon: "shield",    mode: "grid",   days: ["Mon","Tue","Wed","Thu","Fri","Sat","Sun"], duties: ["Gate", "Patrol", "CCTV Monitor", "Response Team"] },
    volunteer:  { label: "Volunteer / NGO",  icon: "hand",      mode: "grid",   days: ["Mon","Wed","Fri","Sat"], duties: ["Outreach", "Logistics", "Registration", "Distribution"] }
  };
  var GATE_ICONS = {
    briefcase: '<svg viewBox="0 0 24 24"><rect x="3" y="7" width="18" height="13" rx="2"/><path d="M8 7V5a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/></svg>',
    church: '<svg viewBox="0 0 24 24"><path d="M12 2v6M9 5h6"/><path d="M4 21V11l8-6 8 6v10"/><path d="M9 21v-6h6v6"/></svg>',
    pulse: '<svg viewBox="0 0 24 24"><path d="M3 12h4l2 7 4-14 2 7h6"/></svg>',
    book: '<svg viewBox="0 0 24 24"><path d="M4 5.5A2.5 2.5 0 0 1 6.5 3H20v16H6.5A2.5 2.5 0 0 0 4 21z"/><path d="M4 5.5v15"/></svg>',
    bed: '<svg viewBox="0 0 24 24"><path d="M3 18v-6a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2v6"/><path d="M3 18v2M21 18v2"/><path d="M3 12V7a2 2 0 0 1 2-2h5v5"/></svg>',
    utensils: '<svg viewBox="0 0 24 24"><path d="M6 3v7a2 2 0 0 0 4 0V3M8 10v11"/><path d="M17 3c-1.7 0-3 2-3 5s1.3 5 3 5v8"/></svg>',
    shield: '<svg viewBox="0 0 24 24"><path d="M12 2 4 5v6c0 5 3.4 8.7 8 11 4.6-2.3 8-6 8-11V5z"/></svg>',
    hand: '<svg viewBox="0 0 24 24"><path d="M8 12V5a1.5 1.5 0 0 1 3 0v6"/><path d="M11 11V4a1.5 1.5 0 0 1 3 0v7"/><path d="M14 11V6a1.5 1.5 0 0 1 3 0v8"/><path d="M6 13l1 6a2 2 0 0 0 2 2h5a4 4 0 0 0 4-4v-4a1.5 1.5 0 0 0-3 0"/></svg>'
  };

  var ALL_WEEKDAYS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];
  var state = { orgType: null, scheduleDays: [], jobTypes: [] };

  // The admin can customize which days/services are on the schedule and
  // what job types workers get assigned to (Schedule setup panel). When
  // set, those overrides take over from the org type's defaults — every
  // other function in the app reads days/duties/services through this one
  // function, so customizing it here is enough to flow everywhere.
  function orgConfig() {
    var base = ORG_TYPES[state.orgType] || ORG_TYPES.business;
    if ((!state.scheduleDays || !state.scheduleDays.length) && (!state.jobTypes || !state.jobTypes.length)) return base;
    var cfg = Object.assign({}, base);
    if (state.scheduleDays && state.scheduleDays.length) {
      if (cfg.mode === "church") cfg.services = state.scheduleDays; else cfg.days = state.scheduleDays;
    }
    if (state.jobTypes && state.jobTypes.length) cfg.duties = state.jobTypes;
    return cfg;
  }

  var orgGate = $("#orgGate");
  var gateGrid = $("#gateGrid");

  function buildGate() {
    if (!gateGrid) return;
    gateGrid.innerHTML = "";
    Object.keys(ORG_TYPES).forEach(function (key) {
      var cfg = ORG_TYPES[key];
      var sub = cfg.mode === "church" ? cfg.services.slice(0, 2).join(" · ") + "…" : cfg.days.join(" · ");
      var card = el("button", "gate-card");
      card.innerHTML = GATE_ICONS[cfg.icon] + "<span class='gate-card-label'>" + cfg.label + "</span><span class='gate-card-sub'>" + sub + "</span>";
      card.addEventListener("click", function () { selectOrg(key); });
      gateGrid.appendChild(card);
    });
  }

  function selectOrg(key) {
    state.orgType = key;
    state.scheduleDays = [];
    state.jobTypes = [];
    orgGate.classList.add("is-hidden");
    ShiftFlowAPI.setOrg(key).catch(function () {});
    enterAdmin(); // whoever sets up the org type becomes the first admin session
    refreshOrgDependentUI();
    showToast("Set up for " + ORG_TYPES[key].label + ". Change this anytime from the sidebar.");
  }

  function refreshOrgDependentUI() {
    var cfg = orgConfig();
    $("#navScheduleLabel").textContent = cfg.mode === "church" ? "Sunday Services" : "Schedule";
    $("#sidebarOrgLabel").textContent = cfg.label;
    $("#scheduleLede").textContent = team.length === 0
      ? "Add workers on the Team tab to start building your schedule."
      : (cfg.mode === "church"
        ? "Assign who's covering each ministry duty, service by service."
        : "The same person can cover a different role each day — set it per worker, per day.");
    $("#statOpenLabel").textContent = cfg.mode === "church" ? "Unfilled duties" : "Open shifts";
    if (autoAssignLabel) autoAssignLabel.textContent = cfg.mode === "church" ? "Auto-assign services" : "Auto-assign open shifts";
    if (autoAssignBtn) autoAssignBtn.hidden = team.length === 0;
    renderSchedule();
    renderTodayShifts();
    populateRoleSelect();
    renderScheduleSetup();
  }

  buildGate();

  var orgGateBackBtn = $("#orgGateBackBtn");
  var switchOrgBtn = $("#switchOrgBtn");
  if (switchOrgBtn) {
    switchOrgBtn.addEventListener("click", function () {
      orgGate.classList.remove("is-hidden");
      if (orgGateBackBtn) orgGateBackBtn.hidden = false; // only offer a way out when there's something to go back to
      closeSidebar();
    });
  }
  if (orgGateBackBtn) {
    orgGateBackBtn.addEventListener("click", function () {
      orgGate.classList.add("is-hidden");
    });
  }

  /* ---------------------------------------------
     1. Sidebar / view navigation
  --------------------------------------------- */
  var sidebar = $("#sidebar");
  var overlay = $("#sidebarOverlay");
  var hamburgerBtn = $("#hamburgerBtn");
  var sidebarClose = $("#sidebarClose");
  var topbarTitle = $("#topbarTitle");
  var navBtns = $all(".nav-btn");
  var views = $all(".view");

  var VIEW_TITLES = {
    overview: "Overview",
    schedule: "Schedule",
    swaps: "Shift Swaps",
    attendance: "Attendance",
    chat: "Team Chat",
    announcements: "Announcements",
    team: "Team",
    reports: "Reports"
  };

  function openSidebar() { sidebar.classList.add("is-open"); overlay.classList.add("is-open"); }
  function closeSidebar() { sidebar.classList.remove("is-open"); overlay.classList.remove("is-open"); }
  hamburgerBtn.addEventListener("click", openSidebar);
  sidebarClose.addEventListener("click", closeSidebar);
  overlay.addEventListener("click", closeSidebar);

  function showView(name) {
    views.forEach(function (v) {
      var match = v.id === "view-" + name;
      v.hidden = !match;
      v.classList.toggle("is-active", match);
    });
    navBtns.forEach(function (b) { b.classList.toggle("is-active", b.dataset.view === name); });
    topbarTitle.textContent = name === "schedule" ? $("#navScheduleLabel").textContent : (VIEW_TITLES[name] || "ShiftFlow");
    closeSidebar();
  }
  navBtns.forEach(function (btn) {
    btn.addEventListener("click", function () { showView(btn.dataset.view); });
  });

  /* ---------------------------------------------
     2. Notifications (bell dropdown)
  --------------------------------------------- */
  var notifBtn = $("#notifBtn");
  var notifPanel = $("#notifPanel");
  var notifBadge = $("#notifBadge");
  var notifList = $("#notifList");
  var NOTIF_COLORS = {
    swap: { bg: "var(--coral-tint)", fg: "var(--coral)" },
    schedule: { bg: "var(--teal-tint)", fg: "var(--teal-2)" },
    announcement: { bg: "var(--amber-tint)", fg: "#7a5310" }
  };
  var notifications = [];

  function iconFor(type) {
    if (type === "swap") return '<svg viewBox="0 0 24 24"><path d="M4 8h13l-3.5-3.5"/><path d="M20 16H7l3.5 3.5"/></svg>';
    if (type === "schedule") return '<svg viewBox="0 0 24 24"><rect x="3" y="4.5" width="18" height="16" rx="2"/><line x1="3" y1="9.5" x2="21" y2="9.5"/></svg>';
    return '<svg viewBox="0 0 24 24"><path d="M4 10v4h3l5 4V6l-5 4z"/></svg>';
  }
  function renderNotifications() {
    notifList.innerHTML = "";
    if (notifications.length === 0) {
      notifList.appendChild(el("p", "empty-state", "No notifications yet."));
    }
    notifications.forEach(function (n) {
      var colors = NOTIF_COLORS[n.type] || NOTIF_COLORS.schedule;
      var item = el("div", "notif-item");
      var icon = el("div", "notif-icon", iconFor(n.type));
      icon.style.background = colors.bg;
      icon.style.color = colors.fg;
      var body = el("div", "", "<p class='notif-title'>" + escapeHtml(n.title) + "</p><p class='notif-sub'>" + escapeHtml(n.sub) + "</p><p class='notif-time'>" + n.time + "</p>");
      item.appendChild(icon);
      item.appendChild(body);
      notifList.appendChild(item);
    });
    notifBadge.hidden = notifications.length === 0;
    notifBadge.textContent = notifications.length;
  }
  function pushNotification(n) {
    notifications.unshift(n);
    renderNotifications();
  }
  notifBtn.addEventListener("click", function (e) {
    e.stopPropagation();
    notifPanel.classList.toggle("is-open");
  });
  document.addEventListener("click", function (e) {
    if (!notifPanel.contains(e.target) && e.target !== notifBtn) notifPanel.classList.remove("is-open");
  });
  renderNotifications();

  /* ---------------------------------------------
     3. Activity log (drives Overview's "Recent activity")
  --------------------------------------------- */
  var activityLog = [];
  function pushActivity(text) {
    activityLog.unshift({ text: text, time: timeNow() });
    activityLog = activityLog.slice(0, 12);
    renderActivity();
  }
  function renderActivity() {
    var list = $("#activityList");
    if (!list) return;
    list.innerHTML = "";
    if (activityLog.length === 0) {
      list.appendChild(el("li", "empty-state", "No activity yet — actions you take will show up here."));
      return;
    }
    activityLog.slice(0, 6).forEach(function (a) {
      var li = el("li", "", "<span class='activity-dot'></span><p>" + a.text + "</p><span class='activity-time'>" + a.time + "</span>");
      list.appendChild(li);
    });
  }

  /* ---------------------------------------------
     4. Team roster
  --------------------------------------------- */
  var team = [];
  var nextWorkerId = 1;

  function generatePin() {
    return String(Math.floor(1000 + Math.random() * 9000));
  }

  function renderTeam() {
    var grid = $("#teamGrid");
    if (!grid) return;
    grid.innerHTML = "";
    if (team.length === 0) {
      grid.appendChild(el("div", "empty-state", "No workers yet. Click \"Add worker\" to build your roster."));
      return;
    }
    team.forEach(function (m) {
      var card = el("div", "team-card");
      card.innerHTML =
        "<button class='team-card-remove' aria-label='Remove " + escapeHtml(m.name) + "'><svg viewBox='0 0 24 24'><line x1='5' y1='5' x2='19' y2='19'/><line x1='19' y1='5' x2='5' y2='19'/></svg></button>" +
        "<span class='avatar'>" + initials(m.name) + "</span>" +
        "<p class='team-name'>" + escapeHtml(m.name) + "</p>" +
        "<p class='team-role'>" + escapeHtml(m.role) + "</p>" +
        (m.email ? "<p class='team-email'>" + escapeHtml(m.email) + "</p>" : "") +
        "<p class='team-pin'>Worker PIN: " + escapeHtml(m.pin || "----") + "</p>" +
        "<button class='team-pin-regen' type='button'>New PIN</button>" +
        "<button type='button' class='team-status " + (m.on ? "on" : "off") + "' title='Click to toggle'>" + (m.on ? "On shift" : "Off shift") + "</button>" +
        (m.invitedAt ? "<span class='team-invited' title='Invited " + escapeHtml(new Date(m.invitedAt).toLocaleString()) + "'>Invited</span>" : "") +
        "<div class='team-invite-row'>" +
          "<button class='btn btn-ghost btn-sm team-invite-copy' type='button'>" + (m.invitedAt ? "Copy invite again" : "Copy invite") + "</button>" +
          (m.email ? "<button class='btn btn-ghost btn-sm team-invite-email' type='button'>" + (m.invitedAt ? "Re-send email" : "Email invite") + "</button>" : "") +
        "</div>";
      card.querySelector(".team-card-remove").addEventListener("click", function () { removeWorker(m.id); });
      card.querySelector(".team-pin-regen").addEventListener("click", function () { regenerateWorkerPin(m.id); });
      card.querySelector(".team-status").addEventListener("click", function () { toggleWorkerStatus(m.id); });
      card.querySelector(".team-invite-copy").addEventListener("click", function () { copyInvite(m); });
      var emailBtn = card.querySelector(".team-invite-email");
      if (emailBtn) emailBtn.addEventListener("click", function () { emailInvite(m); });
      grid.appendChild(card);
    });
  }

  function toggleWorkerStatus(id, forceOn) {
    var worker = team.find(function (m) { return m.id === id; });
    if (!worker) return;
    worker.on = typeof forceOn === "boolean" ? forceOn : !worker.on;
    renderTeam();
    renderSchedule();
    renderTodayShifts();
    updateStatCards();
    ShiftFlowAPI.setWorkerStatus(id, worker.on ? "on" : "off").catch(function () {});
    return worker;
  }

  function inviteMessage(worker) {
    var url = window.location.origin + window.location.pathname;
    return "You're on the ShiftFlow schedule as " + worker.name + " (" + worker.role + ").\n" +
      "Open " + url + ", choose \"I'm a worker,\" pick your name, and sign in with this PIN: " + worker.pin;
  }

  function markInvited(worker) {
    worker.invitedAt = new Date().toISOString();
    renderTeam();
    ShiftFlowAPI.markInvited(worker.id).catch(function () {});
  }

  function copyInvite(worker) {
    var text = inviteMessage(worker);
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(text).then(function () {
        showToast("Invite copied — paste it into a text or chat message.");
        markInvited(worker);
      }).catch(function () {
        showToast("Couldn't copy automatically — here's the PIN: " + worker.pin, true);
      });
    } else {
      showToast("Couldn't copy automatically — here's the PIN: " + worker.pin, true);
    }
  }

  // Tries to actually deliver the invite from the server (works once
  // deployed with RESEND_API_KEY set — see server.js). If there's no
  // backend, or the deployed server has no email service configured,
  // falls back to opening the admin's own mail client so this still
  // works with zero setup.
  function emailInvite(worker) {
    ShiftFlowAPI.sendInvite(worker.id).then(function (result) {
      if (result && result.sent) {
        worker.invitedAt = new Date().toISOString();
        renderTeam();
        showToast("Invite emailed to " + worker.email + ".");
        return;
      }
      var subject = "Your ShiftFlow sign-in";
      var body = inviteMessage(worker);
      var mailto = "mailto:" + encodeURIComponent(worker.email) + "?subject=" + encodeURIComponent(subject) + "&body=" + encodeURIComponent(body);
      window.location.href = mailto;
      markInvited(worker);
    }).catch(function () {
      var subject = "Your ShiftFlow sign-in";
      var body = inviteMessage(worker);
      var mailto = "mailto:" + encodeURIComponent(worker.email) + "?subject=" + encodeURIComponent(subject) + "&body=" + encodeURIComponent(body);
      window.location.href = mailto;
      markInvited(worker);
    });
  }

  function regenerateWorkerPin(id) {
    var worker = team.find(function (m) { return m.id === id; });
    if (!worker) return;
    worker.pin = generatePin();
    renderTeam();
    ShiftFlowAPI.setWorkerPin(id, worker.pin).catch(function () {});
    showToast(worker.name + "'s new PIN is " + worker.pin + ".");
  }

  function addWorker(data) {
    var localId = nextWorkerId++;
    var worker = { id: localId, name: data.name, role: data.role, on: data.status === "on", email: data.email || "", pin: generatePin(), invitedAt: null };
    team.unshift(worker);
    renderTeam();
    renderSchedule();
    renderTodayShifts();
    updateStatCards();
    showToast(worker.name + " was added — their sign-in PIN is " + worker.pin + ".");
    pushActivity("<strong>" + escapeHtml(worker.name) + "</strong> was added to the roster as " + escapeHtml(worker.role) + ".");
    pushNotification({ type: "schedule", title: "New worker added", sub: worker.name + " (" + worker.role + ") joined the roster.", time: "Just now" });

    // The server assigns its own authoritative id (based on what's actually
    // in data.json) — it can differ from our locally-guessed id, e.g. if
    // another admin tab added someone in between. If we kept using the
    // local id for anything after this (assigning duties, removing them),
    // it would silently write to a worker record that doesn't exist on the
    // server, and the real worker would never see it. So once the server
    // confirms, swap our local id for the real one everywhere it's used.
    ShiftFlowAPI.addWorker({ name: worker.name, role: worker.role, status: data.status, email: worker.email, pin: worker.pin }).then(function (serverWorker) {
      if (!serverWorker || serverWorker.id === localId) return;
      worker.id = serverWorker.id;
      if (duties[localId]) { duties[serverWorker.id] = duties[localId]; delete duties[localId]; }
      if (churchAssignments) {
        Object.keys(churchAssignments).forEach(function (duty) {
          Object.keys(churchAssignments[duty]).forEach(function (service) {
            if (String(churchAssignments[duty][service]) === String(localId)) churchAssignments[duty][service] = serverWorker.id;
          });
        });
      }
      renderTeam();
      renderSchedule();
    }).catch(function () {});
  }

  function removeWorkerDirect(id) {
    var worker = team.find(function (m) { return m.id === id; });
    if (!worker) return null;
    team = team.filter(function (m) { return m.id !== id; });
    delete duties[id];
    Object.keys(churchAssignments).forEach(function (duty) {
      Object.keys(churchAssignments[duty] || {}).forEach(function (service) {
        if (String(churchAssignments[duty][service]) === String(id)) {
          delete churchAssignments[duty][service];
          ShiftFlowAPI.setChurchAssignment(duty, service, "").catch(function () {});
        }
      });
    });
    renderTeam();
    renderSchedule();
    renderTodayShifts();
    updateStatCards();
    ShiftFlowAPI.removeWorker(id).catch(function () {});
    showToast(worker.name + " was removed from the roster.");
    pushActivity("<strong>" + escapeHtml(worker.name) + "</strong> was removed from the roster.");
    return worker;
  }

  function removeWorker(id) {
    var worker = team.find(function (m) { return m.id === id; });
    if (!worker) return;
    if (!window.confirm("Remove " + worker.name + " from the roster?")) return;
    removeWorkerDirect(id);
  }

  function populateRoleSelect() {
    var select = $("#workerRole");
    if (!select) return;
    var cfg = orgConfig();
    select.innerHTML = "";
    cfg.duties.forEach(function (d) {
      var opt = document.createElement("option");
      opt.value = d; opt.textContent = d;
      select.appendChild(opt);
    });
  }

  /* ---------------------------------------------
     4b. Schedule setup — admin picks which days/services are on the
     schedule and what job types workers can be assigned to.
  --------------------------------------------- */
  function renderTagPills(container, items, onRemove) {
    container.innerHTML = "";
    if (items.length === 0) {
      container.appendChild(el("span", "field-hint", "None yet — add one below."));
      return;
    }
    items.forEach(function (item) {
      var pill = el("span", "tag-pill");
      pill.appendChild(document.createTextNode(item));
      var removeBtn = el("button", "tag-pill-remove", "×");
      removeBtn.type = "button";
      removeBtn.setAttribute("aria-label", "Remove " + item);
      removeBtn.addEventListener("click", function () { onRemove(item); });
      pill.appendChild(removeBtn);
      container.appendChild(pill);
    });
  }

  function afterScheduleConfigChange() {
    renderScheduleSetup();
    renderSchedule();
    renderTodayShifts();
    updateStatCards();
    renderBarChart();
  }

  function setScheduleDays(newDays) {
    state.scheduleDays = newDays;
    ShiftFlowAPI.setScheduleConfig({ days: newDays }).catch(function () {});
    afterScheduleConfigChange();
  }

  function setJobTypes(newDuties) {
    state.jobTypes = newDuties;
    ShiftFlowAPI.setScheduleConfig({ duties: newDuties }).catch(function () {});
    afterScheduleConfigChange();
  }

  function renderScheduleSetup() {
    var daysWrap = $("#dayPicker");
    var jobWrap = $("#jobTypeList");
    if (!daysWrap || !jobWrap) return;
    var cfg = orgConfig();
    var daysLabel = $("#scheduleSetupDaysLabel");
    var daysHint = $("#scheduleSetupDaysHint");
    daysWrap.innerHTML = "";

    if (cfg.mode === "church") {
      daysLabel.textContent = "Services";
      daysHint.textContent = "The services that appear as columns on the schedule.";
      renderTagPills(daysWrap, cfg.services, function (removed) {
        setScheduleDays(cfg.services.filter(function (s) { return s !== removed; }));
      });
      var serviceAddRow = el("div", "tag-add-row");
      var serviceInput = document.createElement("input");
      serviceInput.type = "text"; serviceInput.placeholder = "e.g. Sunrise Service"; serviceInput.maxLength = 60;
      var serviceAddBtn = el("button", "btn btn-ghost btn-sm", "Add");
      serviceAddBtn.type = "button";
      function addService() {
        var val = serviceInput.value.trim();
        if (!val) return;
        if (cfg.services.some(function (s) { return s.toLowerCase() === val.toLowerCase(); })) { showToast("That service already exists.", true); return; }
        setScheduleDays(cfg.services.concat([val]));
        serviceInput.value = "";
      }
      serviceAddBtn.addEventListener("click", addService);
      serviceInput.addEventListener("keydown", function (e) { if (e.key === "Enter") { e.preventDefault(); addService(); } });
      serviceAddRow.appendChild(serviceInput);
      serviceAddRow.appendChild(serviceAddBtn);
      daysWrap.appendChild(serviceAddRow);
    } else {
      daysLabel.textContent = "Working days";
      daysHint.textContent = "Choose which days appear on the schedule grid.";
      ALL_WEEKDAYS.forEach(function (d) {
        var active = cfg.days.indexOf(d) !== -1;
        var chip = el("button", "day-chip" + (active ? " is-active" : ""), d);
        chip.type = "button";
        chip.setAttribute("aria-pressed", String(active));
        chip.addEventListener("click", function () {
          var current = cfg.days.slice();
          if (active) {
            if (current.length === 1) { showToast("Keep at least one working day.", true); return; }
            current = current.filter(function (x) { return x !== d; });
          } else {
            current.push(d);
          }
          current = ALL_WEEKDAYS.filter(function (x) { return current.indexOf(x) !== -1; });
          setScheduleDays(current);
        });
        daysWrap.appendChild(chip);
      });
    }

    renderTagPills(jobWrap, cfg.duties, function (removed) {
      if (cfg.duties.length === 1) { showToast("Keep at least one job type.", true); return; }
      setJobTypes(cfg.duties.filter(function (d) { return d !== removed; }));
    });
  }

  var scheduleSetupBtn = $("#scheduleSetupBtn");
  var scheduleSetupWrap = $("#scheduleSetupWrap");
  if (scheduleSetupBtn) {
    scheduleSetupBtn.addEventListener("click", function () {
      scheduleSetupWrap.hidden = !scheduleSetupWrap.hidden;
      if (!scheduleSetupWrap.hidden) renderScheduleSetup();
    });
  }
  var jobTypeInput = $("#jobTypeInput");
  var jobTypeAddBtn = $("#jobTypeAddBtn");
  function addJobType() {
    var val = jobTypeInput.value.trim();
    if (!val) return;
    var cfg = orgConfig();
    if (cfg.duties.some(function (d) { return d.toLowerCase() === val.toLowerCase(); })) { showToast("That job type already exists.", true); return; }
    setJobTypes(cfg.duties.concat([val]));
    jobTypeInput.value = "";
  }
  if (jobTypeAddBtn) jobTypeAddBtn.addEventListener("click", addJobType);
  if (jobTypeInput) jobTypeInput.addEventListener("keydown", function (e) { if (e.key === "Enter") { e.preventDefault(); addJobType(); } });

  var scheduleSetupResetBtn = $("#scheduleSetupResetBtn");
  if (scheduleSetupResetBtn) {
    scheduleSetupResetBtn.addEventListener("click", function () {
      if (!window.confirm("Reset working days/services and job types back to " + orgConfig().label + " defaults?")) return;
      state.scheduleDays = [];
      state.jobTypes = [];
      ShiftFlowAPI.setScheduleConfig({ days: [], duties: [] }).catch(function () {});
      afterScheduleConfigChange();
      showToast("Schedule setup reset to defaults.");
    });
  }

  var addWorkerBtn = $("#addWorkerBtn");
  var workerFormWrap = $("#workerFormWrap");
  var workerForm = $("#workerForm");
  var cancelWorkerBtn = $("#cancelWorkerBtn");
  var workerSubmitBtn = $("#workerSubmitBtn");

  function openWorkerForm() {
    populateRoleSelect();
    workerFormWrap.hidden = false;
    $("#workerName").focus();
    addWorkerBtn.innerHTML = "<svg viewBox='0 0 24 24'><line x1='5' y1='5' x2='19' y2='19'/><line x1='19' y1='5' x2='5' y2='19'/></svg> Close";
  }
  function closeWorkerForm() {
    workerFormWrap.hidden = true;
    workerForm.reset();
    addWorkerBtn.innerHTML = "<svg viewBox='0 0 24 24'><line x1='12' y1='5' x2='12' y2='19'/><line x1='5' y1='12' x2='19' y2='12'/></svg> Add worker";
  }
  if (addWorkerBtn) addWorkerBtn.addEventListener("click", function () { workerFormWrap.hidden ? openWorkerForm() : closeWorkerForm(); });
  if (cancelWorkerBtn) cancelWorkerBtn.addEventListener("click", closeWorkerForm);

  function submitWorkerForm() {
    var nameField = $("#workerName");
    var name = nameField.value.trim();
    var role = $("#workerRole").value.trim();
    var status = $("#workerStatus").value;
    var emailField = $("#workerEmail");
    var email = emailField.value.trim();
    if (!name) { showToast("Enter a name first.", true); nameField.focus(); return; }
    if (!role) { showToast("Pick a role first.", true); return; }
    if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) { showToast("That email doesn't look right.", true); emailField.focus(); return; }
    addWorker({ name: name, role: role, status: status, email: email });
    closeWorkerForm();
  }
  if (workerSubmitBtn) workerSubmitBtn.addEventListener("click", submitWorkerForm);
  if (workerForm) {
    workerForm.addEventListener("submit", function (e) { e.preventDefault(); });
    $all("input", workerForm).forEach(function (input) {
      input.addEventListener("keydown", function (e) { if (e.key === "Enter") { e.preventDefault(); submitWorkerForm(); } });
    });
  }

  /* ---------------------------------------------
     5. Schedule — org-aware structure
     grid mode:   one row per worker, one dropdown per day
     church mode: one row per ministry duty, one dropdown per service
  --------------------------------------------- */
  var duties = {};             // grid mode:   { workerId: { day: dutyName } }
  var churchAssignments = {};  // church mode: { dutyName: { service: workerId } }

  function renderSchedule() {
    var container = $("#scheduleContainer");
    if (!container) return;
    var cfg = orgConfig();
    container.innerHTML = "";

    if (autoAssignBtn) autoAssignBtn.hidden = team.length === 0;
    if (autoAssignLabel) autoAssignLabel.textContent = cfg.mode === "church" ? "Auto-assign services" : "Auto-assign open shifts";

    if (team.length === 0) {
      container.appendChild(el("div", "empty-state", "Add workers on the Team tab, then come back here to build the schedule."));
      return;
    }

    if (cfg.mode === "church") {
      renderChurchGrid(container, cfg);
    } else {
      renderWeekGrid(container, cfg);
    }
  }

  function renderWeekGrid(container, cfg) {
    var grid = el("div", "schedule-grid is-grid-mode");
    grid.style.setProperty("--day-count", cfg.days.length);
    grid.appendChild(el("div", "sched-head", ""));
    cfg.days.forEach(function (d) { var head = el("div", "sched-head"); head.textContent = d; grid.appendChild(head); });

    team.forEach(function (worker) {
      var label = el("div", "sched-rowlabel", "<span class='avatar'>" + initials(worker.name) + "</span><span class='sched-rowlabel-name'>" + escapeHtml(worker.name) + "</span>");
      grid.appendChild(label);
      if (!duties[worker.id]) duties[worker.id] = {};

      cfg.days.forEach(function (day) {
        var cellWrap = el("div", "sched-cell");
        var select = document.createElement("select");
        var offOpt = document.createElement("option");
        offOpt.value = "Off"; offOpt.textContent = "Off";
        select.appendChild(offOpt);
        cfg.duties.forEach(function (d) {
          var opt = document.createElement("option");
          opt.value = d; opt.textContent = d;
          select.appendChild(opt);
        });
        var current = duties[worker.id][day] || "Off";
        if (!cfg.duties.includes(current) && current !== "Off") {
          var extraOpt = document.createElement("option");
          extraOpt.value = current; extraOpt.textContent = current;
          select.appendChild(extraOpt);
        }
        select.value = current;
        select.classList.toggle("is-off", current === "Off");
        select.addEventListener("change", function () {
          duties[worker.id][day] = select.value;
          select.classList.toggle("is-off", select.value === "Off");
          ShiftFlowAPI.setDuty(worker.id, day, select.value).catch(function () {});
          renderTodayShifts();
          updateStatCards();
          pushActivity("<strong>" + escapeHtml(worker.name) + "</strong> set to " + escapeHtml(select.value) + " on " + escapeHtml(day) + ".");
        });
        cellWrap.appendChild(select);
        grid.appendChild(cellWrap);
      });
    });
    container.appendChild(grid);
  }

  function renderChurchGrid(container, cfg) {
    var grid = el("div", "schedule-grid is-church-mode");
    grid.style.setProperty("--service-count", cfg.services.length);
    grid.appendChild(el("div", "sched-head", ""));
    cfg.services.forEach(function (s) { var head = el("div", "sched-head"); head.textContent = s; grid.appendChild(head); });

    cfg.duties.forEach(function (duty) {
      var label = el("div", "sched-rowlabel-plain", "");
      label.textContent = duty;
      grid.appendChild(label);
      if (!churchAssignments[duty]) churchAssignments[duty] = {};

      cfg.services.forEach(function (service) {
        var cellWrap = el("div", "sched-cell");
        var select = document.createElement("select");
        var unassignedOpt = document.createElement("option");
        unassignedOpt.value = ""; unassignedOpt.textContent = "Unassigned";
        select.appendChild(unassignedOpt);
        team.forEach(function (worker) {
          var opt = document.createElement("option");
          opt.value = worker.id; opt.textContent = worker.name;
          select.appendChild(opt);
        });
        var current = churchAssignments[duty][service] || "";
        select.value = current;
        select.classList.toggle("is-off", current === "");
        select.addEventListener("change", function () {
          churchAssignments[duty][service] = select.value;
          select.classList.toggle("is-off", select.value === "");
          ShiftFlowAPI.setChurchAssignment(duty, service, select.value).catch(function () {});
          renderTodayShifts();
          updateStatCards();
          var assignedWorker = team.find(function (w) { return String(w.id) === String(select.value); });
          if (assignedWorker) {
            pushActivity("<strong>" + escapeHtml(assignedWorker.name) + "</strong> assigned to " + escapeHtml(duty) + " for " + escapeHtml(service) + ".");
          } else {
            pushActivity(escapeHtml(duty) + " for " + escapeHtml(service) + " is now unassigned.");
          }
        });
        cellWrap.appendChild(select);
        grid.appendChild(cellWrap);
      });
    });
    container.appendChild(grid);
  }

  /* ---------------------------------------------
     5b. Auto-assign — fills OPEN slots only, matching each
     worker's role to the duty needed, rotating fairly among
     equally-qualified workers so no one gets overloaded.
     This never touches a slot someone already set manually.
  --------------------------------------------- */
  var autoAssignBtn = $("#autoAssignBtn");
  var autoAssignLabel = $("#autoAssignLabel");

  function autoAssignGrid(cfg) {
    var loadCount = {};
    team.forEach(function (w) { loadCount[w.id] = 0; });
    team.forEach(function (w) {
      cfg.days.forEach(function (d) { if (duties[w.id] && duties[w.id][d] && duties[w.id][d] !== "Off") loadCount[w.id]++; });
    });

    var filled = 0;
    cfg.days.forEach(function (day) {
      team.forEach(function (worker) {
        if (!duties[worker.id]) duties[worker.id] = {};
        var current = duties[worker.id][day];
        if (current && current !== "Off") return; // already set — never overwrite
        if (!cfg.duties.includes(worker.role)) return; // no confident match for this worker
        duties[worker.id][day] = worker.role;
        loadCount[worker.id]++;
        filled++;
        ShiftFlowAPI.setDuty(worker.id, day, worker.role).catch(function () {});
      });
    });
    return filled;
  }

  function autoAssignChurch(cfg) {
    var loadCount = {};
    team.forEach(function (w) { loadCount[w.id] = 0; });
    cfg.duties.forEach(function (duty) {
      cfg.services.forEach(function (service) {
        var assigned = churchAssignments[duty] && churchAssignments[duty][service];
        if (assigned) loadCount[assigned] = (loadCount[assigned] || 0) + 1;
      });
    });

    var filled = 0;
    cfg.duties.forEach(function (duty) {
      if (!churchAssignments[duty]) churchAssignments[duty] = {};
      cfg.services.forEach(function (service) {
        if (churchAssignments[duty][service]) return; // already set — never overwrite
        var candidates = team.filter(function (w) { return w.role === duty; });
        if (candidates.length === 0) return; // no one qualified for this ministry duty
        candidates.sort(function (a, b) { return (loadCount[a.id] || 0) - (loadCount[b.id] || 0); });
        var chosen = candidates[0];
        churchAssignments[duty][service] = chosen.id;
        loadCount[chosen.id] = (loadCount[chosen.id] || 0) + 1;
        filled++;
        ShiftFlowAPI.setChurchAssignment(duty, service, chosen.id).catch(function () {});
      });
    });
    return filled;
  }

  function runAutoAssign() {
    if (team.length === 0) { showToast("Add workers first — auto-assign matches them by role.", true); return; }
    var cfg = orgConfig();
    var filled = cfg.mode === "church" ? autoAssignChurch(cfg) : autoAssignGrid(cfg);
    renderSchedule();
    renderTodayShifts();
    updateStatCards();
    renderBarChart();
    if (filled === 0) {
      showToast("Nothing left to auto-assign — either everything's covered, or no one's role matches the open slots.");
    } else {
      showToast("Auto-assigned " + filled + " open " + (filled === 1 ? "slot" : "slots") + " by matching worker roles.");
      pushActivity("Auto-assign filled " + filled + " open " + (filled === 1 ? "slot" : "slots") + " based on worker roles.");
    }
  }
  if (autoAssignBtn) autoAssignBtn.addEventListener("click", runAutoAssign);

  /* ---------------------------------------------
     6. Overview — dynamic "today" panel + stat cards
  --------------------------------------------- */
  var WEEKDAY_KEYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

  function renderTodayShifts() {
    var list = $("#todayList");
    var titleEl = $("#todayPanelTitle");
    if (!list || !titleEl) return;
    var cfg = orgConfig();
    list.innerHTML = "";

    if (team.length === 0) {
      titleEl.textContent = "Today's shifts";
      list.appendChild(el("li", "empty-state", "No one is scheduled yet."));
      return;
    }

    if (cfg.mode === "church") {
      titleEl.textContent = "This Sunday's lineup";
      var rows = [];
      cfg.duties.forEach(function (duty) {
        cfg.services.forEach(function (service) {
          var workerId = churchAssignments[duty] && churchAssignments[duty][service];
          if (!workerId) return;
          var worker = team.find(function (w) { return String(w.id) === String(workerId); });
          if (!worker) return;
          rows.push({ name: worker.name, meta: duty + " · " + service });
        });
      });
      if (rows.length === 0) {
        list.appendChild(el("li", "empty-state", "No one's been assigned yet — set it up on the Sunday Services tab."));
        return;
      }
      rows.slice(0, 8).forEach(function (r) {
        list.appendChild(el("li", "", "<span class='dot dot-on'></span><div><p class='today-name'>" + escapeHtml(r.name) + "</p><p class='today-meta'>" + escapeHtml(r.meta) + "</p></div>"));
      });
    } else {
      titleEl.textContent = "Today's shifts";
      var todayKey = WEEKDAY_KEYS[new Date().getDay()];
      var rows2 = [];
      team.forEach(function (worker) {
        var duty = duties[worker.id] && duties[worker.id][todayKey];
        if (duty && duty !== "Off") rows2.push({ name: worker.name, meta: duty });
      });
      if (rows2.length === 0) {
        if (!cfg.days.includes(todayKey)) {
          list.appendChild(el("li", "empty-state", "Nothing scheduled today — check the Schedule tab for the rest of the week."));
        } else {
          list.appendChild(el("li", "empty-state", "No one's scheduled for today yet — set it up on the Schedule tab."));
        }
        return;
      }
      rows2.forEach(function (r) {
        list.appendChild(el("li", "", "<span class='dot dot-on'></span><div><p class='today-name'>" + escapeHtml(r.name) + "</p><p class='today-meta'>" + escapeHtml(r.meta) + "</p></div>"));
      });
    }
  }

  function updateStatCards() {
    $("#statTeamCount").textContent = team.length;
    $("#statTeamDelta").textContent = team.length === 0 ? "Add your first worker" : (team.filter(function (w) { return w.on; }).length + " currently on shift");

    var cfg = orgConfig();
    var openCount = 0;
    if (cfg.mode === "church") {
      cfg.duties.forEach(function (duty) {
        cfg.services.forEach(function (service) {
          if (!churchAssignments[duty] || !churchAssignments[duty][service]) openCount++;
        });
      });
    } else if (team.length > 0) {
      team.forEach(function (worker) {
        cfg.days.forEach(function (day) {
          var duty = duties[worker.id] && duties[worker.id][day];
          if (!duty || duty === "Off") openCount++;
        });
      });
    }
    $("#statOpenCount").textContent = team.length === 0 ? "0" : openCount;

    var pendingSwaps = swaps.filter(function (s) { return s.status === "pending"; }).length;
    $("#statSwapCount").textContent = pendingSwaps;

    if (attendanceLog.length === 0) {
      $("#statAttendanceRate").textContent = "—";
      $("#statAttendanceDelta").textContent = "No data yet";
    } else {
      var onTime = attendanceLog.filter(function (a) { return a.status === "on-time" || a.status === "active"; }).length;
      var rate = Math.round((onTime / attendanceLog.length) * 100);
      $("#statAttendanceRate").textContent = rate + "%";
      $("#statAttendanceDelta").textContent = attendanceLog.length + " logged";
    }
  }

  /* ---------------------------------------------
     7. Shift swaps
  --------------------------------------------- */
  var swaps = [];
  var nextSwapId = 1;

  function createSwapRequest(swap) {
    swap.id = nextSwapId++;
    swap.status = "pending";
    swaps.unshift(swap);
    renderSwaps();
    ShiftFlowAPI.requestSwap(swap).catch(function () {});
    pushActivity("<strong>" + escapeHtml(swap.from) + "</strong> requested coverage for " + escapeHtml(swap.fromShift) + ".");
    pushNotification({ type: "swap", title: "New swap request", sub: swap.from + " needs coverage for " + swap.fromShift + ".", time: "Just now" });
    return swap;
  }

  function updateSwapCount() {
    var pending = swaps.filter(function (s) { return s.status === "pending"; }).length;
    var badge = $("#navSwapCount");
    badge.hidden = pending === 0;
    badge.textContent = pending;
    updateStatCards();
  }

  function renderSwaps() {
    var list = $("#swapList");
    if (!list) return;
    list.innerHTML = "";
    if (swaps.length === 0) {
      list.appendChild(el("div", "empty-state", "No shift swap requests yet."));
      updateSwapCount();
      return;
    }
    swaps.forEach(function (s) {
      var card = el("div", "swap-card" + (s.status !== "pending" ? " is-resolved" : ""));
      var people = el("div", "swap-people",
        "<span class='swap-id'>#" + s.id + "</span>" +
        "<span class='avatar'>" + initials(s.from) + "</span>" +
        "<div><p class='swap-detail-name'>" + escapeHtml(s.from) + "</p><p class='swap-detail-meta'>" + escapeHtml(s.fromShift) + "</p></div>" +
        "<span class='swap-arrow'><svg viewBox='0 0 24 24'><path d='M5 12h14'/><path d='M13 6l6 6-6 6'/></svg></span>" +
        "<div><p class='swap-detail-name'>" + escapeHtml(s.to) + "</p><p class='swap-detail-meta'>" + escapeHtml(s.toShift) + "</p></div>"
      );
      card.appendChild(people);
      if (s.status === "pending") {
        var actions = el("div", "swap-actions");
        var approveBtn = el("button", "btn btn-sm btn-approve", "Approve");
        var declineBtn = el("button", "btn btn-sm btn-decline", "Decline");
        approveBtn.addEventListener("click", function () { resolveSwap(s.id, "approved"); });
        declineBtn.addEventListener("click", function () { resolveSwap(s.id, "declined"); });
        actions.appendChild(approveBtn);
        actions.appendChild(declineBtn);
        card.appendChild(actions);
      } else {
        card.appendChild(el("span", "swap-status " + s.status, s.status.charAt(0).toUpperCase() + s.status.slice(1)));
      }
      list.appendChild(card);
    });
    updateSwapCount();
  }

  function resolveSwap(id, status) {
    var swap = swaps.find(function (s) { return s.id === id; });
    if (!swap) return;
    swap.status = status;
    renderSwaps();
    ShiftFlowAPI.resolveSwap(id, status).catch(function () {});
    showToast("Swap " + status + " for " + swap.from + " and " + swap.to + ".");
    pushActivity("Shift swap between <strong>" + escapeHtml(swap.from) + "</strong> and <strong>" + escapeHtml(swap.to) + "</strong> was " + status + ".");
    pushNotification({ type: "swap", title: "Swap " + status, sub: swap.from + " ↔ " + swap.to + " — " + status + ".", time: "Just now" });
  }

  /* ---------------------------------------------
     8. Attendance / clock in-out
  --------------------------------------------- */
  var clockBtn = $("#clockBtn");
  var clockStatus = $("#clockStatus");
  var clockTime = $("#clockTime");
  var attendanceBody = $("#attendanceBody");
  var clockedIn = false;
  var clockInterval = null;
  var seconds = 0;
  var attendanceLog = [];

  function renderAttendance() {
    if (!attendanceBody) return;
    attendanceBody.innerHTML = "";
    if (attendanceLog.length === 0) {
      var tr = document.createElement("tr");
      var td = document.createElement("td");
      td.colSpan = 5;
      td.className = "empty-state";
      td.textContent = "No attendance logged yet.";
      tr.appendChild(td);
      attendanceBody.appendChild(tr);
      return;
    }
    attendanceLog.forEach(function (row) {
      var r = el("tr", "", "<td>" + escapeHtml(row.name) + "</td><td>" + escapeHtml(row.role) + "</td><td>" + row.inT + "</td><td>" + row.outT + "</td><td><span class='status-pill " + row.status + "'>" + row.status.replace("-", " ") + "</span></td>");
      attendanceBody.appendChild(r);
    });
  }

  function formatClock(totalSeconds) {
    var h = Math.floor(totalSeconds / 3600), m = Math.floor((totalSeconds % 3600) / 60), s = totalSeconds % 60;
    function pad(n) { return (n < 10 ? "0" : "") + n; }
    return pad(h) + ":" + pad(m) + ":" + pad(s);
  }

  var workerClockBtn = $("#workerClockBtn");
  var workerClockStatus = $("#workerClockStatus");
  var workerClockTime = $("#workerClockTime");
  var workerClockedIn = false;
  var workerClockInterval = null;
  var workerSeconds = 0;

  function makeClockHandler(opts) {
    // opts: { btn, statusEl, timeEl, getClockedIn, setClockedIn, getInterval, setInterval, getSeconds, setSeconds, personName, personRole }
    return function () {
      var clockedInNow = !opts.getClockedIn();
      opts.setClockedIn(clockedInNow);
      if (clockedInNow) {
        opts.btn.textContent = "Clock out";
        opts.btn.classList.add("is-on");
        opts.statusEl.textContent = "You're clocked in";
        opts.setSeconds(0);
        var interval = window.setInterval(function () {
          opts.setSeconds(opts.getSeconds() + 1);
          opts.timeEl.textContent = formatClock(opts.getSeconds());
        }, 1000);
        opts.setInterval(interval);
        attendanceLog.unshift({ name: opts.personName(), role: opts.personRole(), inT: timeNow(), outT: "—", status: "active" });
        renderAttendance();
        updateStatCards();
        ShiftFlowAPI.logAttendance(attendanceLog[0]).catch(function () {});
        showToast("Clocked in at " + timeNow() + ".");
        pushActivity("<strong>" + escapeHtml(opts.personName()) + "</strong> clocked in at " + timeNow() + ".");
      } else {
        opts.btn.textContent = "Clock in";
        opts.btn.classList.remove("is-on");
        opts.statusEl.textContent = "You're clocked out";
        window.clearInterval(opts.getInterval());
        var entry = attendanceLog.find(function (a) { return a.name === opts.personName() && a.status === "active"; });
        if (entry) { entry.outT = timeNow(); entry.status = "on-time"; }
        renderAttendance();
        updateStatCards();
        if (entry) ShiftFlowAPI.logAttendance(entry).catch(function () {});
        showToast("Clocked out at " + timeNow() + ".");
        pushActivity("<strong>" + escapeHtml(opts.personName()) + "</strong> clocked out at " + timeNow() + ".");
      }
    };
  }

  if (clockBtn) {
    clockBtn.addEventListener("click", makeClockHandler({
      btn: clockBtn, statusEl: clockStatus, timeEl: clockTime,
      getClockedIn: function () { return clockedIn; }, setClockedIn: function (v) { clockedIn = v; },
      getInterval: function () { return clockInterval; }, setInterval: function (v) { clockInterval = v; },
      getSeconds: function () { return seconds; }, setSeconds: function (v) { seconds = v; },
      personName: function () { return "Admin"; }, personRole: function () { return "Admin"; }
    }));
  }
  if (workerClockBtn) {
    workerClockBtn.addEventListener("click", makeClockHandler({
      btn: workerClockBtn, statusEl: workerClockStatus, timeEl: workerClockTime,
      getClockedIn: function () { return workerClockedIn; }, setClockedIn: function (v) { workerClockedIn = v; },
      getInterval: function () { return workerClockInterval; }, setInterval: function (v) { workerClockInterval = v; },
      getSeconds: function () { return workerSeconds; }, setSeconds: function (v) { workerSeconds = v; },
      personName: function () { return currentWorker ? currentWorker.name : "Worker"; }, personRole: function () { return currentWorker ? currentWorker.role : "Worker"; }
    }));
  }

  /* ---------------------------------------------
     9. Team chat — real per-channel messaging with
     backend polling so messages sync across sessions
     when server.js is running. Shared between the admin
     dashboard and the worker view — both render from the
     same chatData/currentChannel state.
  --------------------------------------------- */
  var chatData = { general: [], schedule: [], announcements: [] };
  var currentChannel = "general";
  var chatThread = $("#chatThread");
  var workerChatThread = $("#workerChatThread");
  var chatForm = $("#chatForm");
  var chatInput = $("#chatInput");
  var chatSendBtn = $("#chatSendBtn");

  function renderChatMessage(container, msg) {
    var wrap = el("div", "chat-msg" + (msg.me ? " is-me" : "") + (msg.system ? " is-system" : ""));
    if (!msg.me) wrap.appendChild(el("span", "avatar", initials(msg.name)));
    wrap.appendChild(el("div", "", "<p class='chat-msg-name'>" + escapeHtml(msg.name) + "</p><div class='chat-msg-bubble'>" + escapeHtml(msg.text) + "</div><p class='chat-msg-time'>" + msg.time + "</p>"));
    container.appendChild(wrap);
  }

  function renderChatThread() {
    var msgs = chatData[currentChannel] || [];
    [chatThread, workerChatThread].forEach(function (container) {
      if (!container) return;
      container.innerHTML = "";
      if (msgs.length === 0) {
        container.appendChild(el("p", "empty-state", "No messages yet — say something to the team."));
        return;
      }
      msgs.forEach(function (m) { renderChatMessage(container, m); });
      container.scrollTop = container.scrollHeight;
    });
  }

  function addChatMessage(channel, msg) {
    if (!chatData[channel]) chatData[channel] = [];
    chatData[channel].push(msg);
    if (channel === currentChannel) renderChatThread();
  }

  function setChannel(channel) {
    currentChannel = channel;
    $all(".channel-btn").forEach(function (b) { b.classList.toggle("is-active", b.dataset.channel === channel || b.dataset.wchannel === channel); });
    renderChatThread();
  }
  $all(".channel-btn").forEach(function (btn) {
    btn.addEventListener("click", function () { setChannel(btn.dataset.channel || btn.dataset.wchannel); });
  });

  // Click + Enter handling, not a <form> submit — sandboxed preview contexts
  // can silently block native form submission, so every action button in
  // this app is wired directly rather than relying on it.
  function sendChatMessageFrom(inputEl) {
    var text = inputEl.value.trim();
    if (!text) { inputEl.focus(); return; }
    var senderName = (accessMode === "worker" && currentWorker) ? currentWorker.name : "You";
    var msg = { name: senderName, me: true, text: text, time: timeNow() };
    addChatMessage(currentChannel, msg);
    ShiftFlowAPI.postChatMessage(currentChannel, msg).catch(function () {});
    inputEl.value = "";
    inputEl.focus();
  }
  if (chatSendBtn) chatSendBtn.addEventListener("click", function () { sendChatMessageFrom(chatInput); });
  if (chatInput) chatInput.addEventListener("keydown", function (e) { if (e.key === "Enter") { e.preventDefault(); sendChatMessageFrom(chatInput); } });
  if (chatForm) chatForm.addEventListener("submit", function (e) { e.preventDefault(); }); // belt-and-suspenders: never actually navigate

  var workerChatInput = $("#workerChatInput");
  var workerChatSendBtn = $("#workerChatSendBtn");
  if (workerChatSendBtn) workerChatSendBtn.addEventListener("click", function () { sendChatMessageFrom(workerChatInput); });
  if (workerChatInput) workerChatInput.addEventListener("keydown", function (e) { if (e.key === "Enter") { e.preventDefault(); sendChatMessageFrom(workerChatInput); } });

  // Poll the backend for new messages from other sessions, so chat actually
  // synchronizes across anyone using the same server — not just this tab.
  // Poll the backend periodically so things actually stay in sync across
  // sessions — critical for a worker who's signed in on their own device
  // to see a swap get approved, or a new shift appear, without having to
  // log out and back in. Deliberately conservative about WHAT it touches:
  // chat, swaps, and announcements are read-mostly (safe to redraw any
  // time), but the admin's live Schedule grid is never touched by polling
  // — rebuilding it out from under someone mid-click would be worse than
  // a few seconds of staleness. A worker's own read-only "My Shifts" list
  // has no such risk, so that does stay live.
  function pollBackend() {
    ShiftFlowAPI.getState().then(function (data) {
      if (!data) return;

      var chatChanged = false;
      if (data.chat) {
        Object.keys(data.chat).forEach(function (ch) {
          var incoming = data.chat[ch] || [];
          var existing = chatData[ch] || [];
          if (incoming.length !== existing.length) { chatData[ch] = incoming; chatChanged = true; }
        });
      }
      if (chatChanged) renderChatThread();

      if (Array.isArray(data.swaps) && data.swaps.length !== swaps.length) {
        swaps = data.swaps;
        nextSwapId = swaps.reduce(function (max, s) { return Math.max(max, s.id || 0); }, 0) + 1;
        renderSwaps();
        if (accessMode === "worker") renderWorkerSwapList();
      } else if (Array.isArray(data.swaps)) {
        // same count, but statuses may have changed (e.g. a request got approved)
        var statusChanged = data.swaps.some(function (s, i) { return swaps[i] && swaps[i].status !== s.status; });
        if (statusChanged) {
          swaps = data.swaps;
          renderSwaps();
          if (accessMode === "worker") renderWorkerSwapList();
        }
      }

      if (Array.isArray(data.announcements) && data.announcements.length !== announcements.length) {
        announcements = data.announcements;
        renderAnnouncements();
        if (accessMode === "worker") renderWorkerAnnouncements();
      }

      if (accessMode === "worker" && currentWorker) {
        if (Array.isArray(data.team)) team = data.team;
        if (data.duties) duties = data.duties;
        if (data.churchAssignments) churchAssignments = data.churchAssignments;
        renderWorkerShifts();
        renderWorkerSwapForm();
      }

      // Roster changes (a worker added/removed from another tab or device)
      // are safe to pick up any time — unlike the Schedule grid, there's no
      // in-progress editing state on the team cards themselves.
      if (accessMode === "admin" && Array.isArray(data.team) && data.team.length !== team.length) {
        team = data.team;
        nextWorkerId = team.reduce(function (max, w) { return Math.max(max, w.id); }, 0) + 1;
        renderTeam();
        renderSchedule();
        renderTodayShifts();
        updateStatCards();
      }
    }).catch(function () {});
  }
  if (!reduceMotion) window.setInterval(pollBackend, 5000);

  /* ---------------------------------------------
     10. Announcements
  --------------------------------------------- */
  var announcements = [];

  function renderAnnouncements() {
    var list = $("#announceList");
    if (!list) return;
    list.innerHTML = "";
    if (announcements.length === 0) {
      list.appendChild(el("div", "empty-state", "No announcements yet."));
      return;
    }
    announcements.forEach(function (a) {
      var card = el("div", "announce-card",
        "<div class='announce-head'><p class='announce-title'>" + escapeHtml(a.title) + "</p><span class='announce-tag'>" + escapeHtml(a.tag || "General") + "</span></div>" +
        "<p class='announce-body'>" + escapeHtml(a.body) + "</p>" +
        "<p class='announce-meta'>" + escapeHtml(a.meta || "Just now") + "</p>"
      );
      list.appendChild(card);
    });
  }

  var addAnnouncementBtn = $("#addAnnouncementBtn");
  var announceFormWrap = $("#announceFormWrap");
  var announceForm = $("#announceForm");
  var cancelAnnounceBtn = $("#cancelAnnounceBtn");
  var announcePostBtn = $("#announcePostBtn");

  function openAnnounceForm() {
    announceFormWrap.hidden = false;
    $("#announceTitle").focus();
    addAnnouncementBtn.innerHTML = "<svg viewBox='0 0 24 24'><line x1='5' y1='5' x2='19' y2='19'/><line x1='19' y1='5' x2='5' y2='19'/></svg> Close";
  }
  function closeAnnounceForm() {
    announceFormWrap.hidden = true;
    announceForm.reset();
    addAnnouncementBtn.innerHTML = "<svg viewBox='0 0 24 24'><line x1='12' y1='5' x2='12' y2='19'/><line x1='5' y1='12' x2='19' y2='12'/></svg> New announcement";
  }
  if (addAnnouncementBtn) addAnnouncementBtn.addEventListener("click", function () { announceFormWrap.hidden ? openAnnounceForm() : closeAnnounceForm(); });
  if (cancelAnnounceBtn) cancelAnnounceBtn.addEventListener("click", closeAnnounceForm);

  function createAnnouncement(title, body, tag) {
    var announcement = { title: title, body: body, tag: tag || "General", meta: "Posted just now" };
    announcements.unshift(announcement);
    renderAnnouncements();
    ShiftFlowAPI.addAnnouncement(announcement).catch(function () {});
    pushActivity("New announcement posted: <strong>" + escapeHtml(title) + "</strong>.");
    pushNotification({ type: "announcement", title: "New announcement", sub: title, time: "Just now" });
    return announcement;
  }

  function submitAnnounceForm() {
    var titleField = $("#announceTitle");
    var title = titleField.value.trim();
    var body = $("#announceBody").value.trim();
    if (!title) { showToast("Give it a title first.", true); titleField.focus(); return; }
    if (!body) { showToast("Add a message body first.", true); return; }
    createAnnouncement(title, body);
    closeAnnounceForm();
  }
  if (announcePostBtn) announcePostBtn.addEventListener("click", submitAnnounceForm);
  if (announceForm) {
    announceForm.addEventListener("submit", function (e) { e.preventDefault(); });
    var announceTitleField = $("#announceTitle");
    if (announceTitleField) announceTitleField.addEventListener("keydown", function (e) { if (e.key === "Enter") { e.preventDefault(); submitAnnounceForm(); } });
  }

  /* ---------------------------------------------
     11. Reports
  --------------------------------------------- */
  function renderBarChart() {
    var chart = $("#barChart");
    if (!chart) return;
    chart.innerHTML = "";
    var cfg = orgConfig();
    var days = cfg.mode === "church" ? cfg.services : cfg.days;
    var hasData = team.length > 0;

    if (!hasData) {
      chart.appendChild(el("div", "empty-state", "Add workers and build a schedule to see hours here."));
      $("#reportAvgHours").textContent = "—";
      $("#reportOvertime").textContent = "—";
      $("#reportNoShows").textContent = "—";
      $("#reportCoverage").textContent = "—";
      return;
    }

    var counts = days.map(function (d) {
      if (cfg.mode === "church") {
        var n = 0;
        cfg.duties.forEach(function (duty) { if (churchAssignments[duty] && churchAssignments[duty][d]) n++; });
        return { d: d, h: n };
      }
      var n2 = 0;
      team.forEach(function (worker) {
        var duty = duties[worker.id] && duties[worker.id][d];
        if (duty && duty !== "Off") n2++;
      });
      return { d: d, h: n2 };
    });
    var max = Math.max.apply(null, counts.map(function (x) { return x.h; })) || 1;
    counts.forEach(function (x) {
      var pct = Math.round((x.h / max) * 100);
      var col = el("div", "bar-col");
      var bar = el("div", "bar");
      bar.style.height = pct + "%";
      col.appendChild(el("div", "bar-value", String(x.h)));
      col.appendChild(bar);
      var barLabel = el("div", "bar-label");
      barLabel.textContent = x.d.length > 8 ? x.d.slice(0, 3) : x.d;
      col.appendChild(barLabel);
      chart.appendChild(col);
    });

    var totalAssignments = counts.reduce(function (sum, x) { return sum + x.h; }, 0);
    $("#reportAvgHours").textContent = team.length ? (totalAssignments / team.length).toFixed(1) : "—";
    $("#reportOvertime").textContent = "0";
    var noShows = attendanceLog.filter(function (a) { return a.status === "absent"; }).length;
    $("#reportNoShows").textContent = noShows;
    var totalSlots = cfg.mode === "church" ? cfg.duties.length * cfg.services.length : team.length * cfg.days.length;
    $("#reportCoverage").textContent = totalSlots ? Math.round((totalAssignments / totalSlots) * 100) + "%" : "—";
  }

  /* ---------------------------------------------
     12. Floating assistant widget — this one actually DOES things,
     not just answers questions. It's a rule-based command parser
     (not a live LLM call — this is a static app with no server-side
     model access), so it recognizes a specific set of phrasings and
     executes the same functions the UI buttons use. When it can't
     confidently match a command, it says so plainly rather than
     guessing, and lists what it does understand.
  --------------------------------------------- */
  var chatFab = $("#chatFab");
  var fabBadge = $("#fabBadge");
  var chatWidget = $("#chatWidget");
  var chatWidgetClose = $("#chatWidgetClose");
  var chatWidgetBody = $("#chatWidgetBody");
  var chatWidgetForm = $("#chatWidgetForm");
  var chatWidgetInput = $("#chatWidgetInput");
  var chatWidgetSendBtn = $("#chatWidgetSendBtn");

  var widgetMessages = [
    { text: "Hi — I'm your ShiftFlow assistant. I can answer questions, and I can also do things for you. Try \"help\" to see what I can run.", me: false, time: timeNow() }
  ];
  var unreadCount = 0;

  function renderWidget() {
    chatWidgetBody.innerHTML = "";
    widgetMessages.forEach(function (m) {
      var wrap = el("div", "cw-msg" + (m.me ? " is-me" : ""));
      wrap.innerHTML = "<div class='cw-msg-bubble'>" + m.text + "</div><div class='cw-msg-time'>" + m.time + "</div>";
      chatWidgetBody.appendChild(wrap);
    });
    chatWidgetBody.scrollTop = chatWidgetBody.scrollHeight;
  }
  function setUnread(n) {
    unreadCount = n;
    fabBadge.hidden = n === 0;
    fabBadge.textContent = n;
  }
  function openWidget() { chatWidget.classList.add("is-open"); setUnread(0); }
  function closeWidget() { chatWidget.classList.remove("is-open"); }
  chatFab.addEventListener("click", function () { chatWidget.classList.contains("is-open") ? closeWidget() : openWidget(); });
  chatWidgetClose.addEventListener("click", closeWidget);

  function findWorkerByName(nameFragment) {
    var frag = nameFragment.trim().toLowerCase();
    var exact = team.filter(function (w) { return w.name.toLowerCase() === frag; });
    if (exact.length === 1) return { match: exact[0] };
    var partial = team.filter(function (w) { return w.name.toLowerCase().indexOf(frag) !== -1; });
    if (partial.length === 1) return { match: partial[0] };
    if (partial.length > 1) return { ambiguous: partial };
    return { none: true };
  }

  var HELP_ADMIN = "Here's what I can run for you:<br>" +
    "• \"add worker Sam as Usher\"<br>" +
    "• \"remove worker Sam\"<br>" +
    "• \"assign Sam to Kitchen on Monday\" (or \"...for First Service\")<br>" +
    "• \"mark Sam on shift\" / \"mark Sam off shift\"<br>" +
    "• \"add job type Delivery Driver\" / \"remove job type Bar\"<br>" +
    "• \"working days: Mon, Tue, Wed\"<br>" +
    "• \"approve swap 3\" or \"approve Sam's swap\"<br>" +
    "• \"decline swap 3\"<br>" +
    "• \"auto-assign open shifts\"<br>" +
    "• \"announce: Title — message\"<br>" +
    "• \"who's on shift\" / \"open shifts\" / \"pending swaps\"";

  var HELP_WORKER = "Here's what I can run for you:<br>" +
    "• \"clock me in\" / \"clock me out\"<br>" +
    "• \"request a swap\"<br>" +
    "• \"my shifts\" / \"my role\"";

  // --- Admin-scoped commands ---
  function tryAdminCommand(raw, lower) {
    if (/^help$|what can you do|what commands/.test(lower)) return HELP_ADMIN;

    // These are checked before the generic add/remove-worker commands
    // below, since phrasings like "remove job type X" would otherwise get
    // swallowed by "remove worker" (its "worker" keyword is optional).
    var shiftStatusMatch = raw.match(/^(?:mark|set)\s+(.+?)\s+(on|off)\s*[- ]?shift$/i);
    if (shiftStatusMatch) {
      var statusTarget = shiftStatusMatch[1].trim();
      var wantOn = shiftStatusMatch[2].toLowerCase() === "on";
      var foundStatus = findWorkerByName(statusTarget);
      if (foundStatus.match) {
        toggleWorkerStatus(foundStatus.match.id, wantOn);
        return escapeHtml(foundStatus.match.name) + " is now " + (wantOn ? "on shift." : "off shift.");
      }
      if (foundStatus.ambiguous) return "That matches more than one person: " + foundStatus.ambiguous.map(function (w) { return escapeHtml(w.name); }).join(", ") + ". Try the full name.";
      return "I couldn't find anyone named \"" + escapeHtml(statusTarget) + "\" on the roster.";
    }

    var addJobMatch = raw.match(/^add(?: a| an)? (?:job ?type|duty|role)\s+(.+)$/i);
    if (addJobMatch) {
      var newJobType = addJobMatch[1].trim();
      var cfgJ = orgConfig();
      if (cfgJ.duties.some(function (d) { return d.toLowerCase() === newJobType.toLowerCase(); })) {
        return "\"" + escapeHtml(newJobType) + "\" is already a job type.";
      }
      setJobTypes(cfgJ.duties.concat([newJobType]));
      return "Added \"" + escapeHtml(newJobType) + "\" as a job type — it'll show up wherever you assign roles.";
    }

    var removeJobMatch = raw.match(/^(?:remove|delete) (?:job ?type|duty|role)\s+(.+)$/i);
    if (removeJobMatch) {
      var jobToRemove = removeJobMatch[1].trim();
      var cfgJ2 = orgConfig();
      var foundJob = cfgJ2.duties.find(function (d) { return d.toLowerCase() === jobToRemove.toLowerCase(); });
      if (!foundJob) return "I don't see a job type called \"" + escapeHtml(jobToRemove) + "\".";
      if (cfgJ2.duties.length === 1) return "You need at least one job type — add another before removing this one.";
      setJobTypes(cfgJ2.duties.filter(function (d) { return d !== foundJob; }));
      return "Removed \"" + escapeHtml(foundJob) + "\" from your job types.";
    }

    var setDaysMatch = raw.match(/^(?:set )?working days?(?: to| is| are)?:?\s+(.+)$/i);
    if (setDaysMatch) {
      var cfgD = orgConfig();
      if (cfgD.mode === "church") return "Church schedules run on services, not days — try \"add job type X\" or manage services from Schedule setup on the Sunday Services tab.";
      var requested = setDaysMatch[1].split(/,| and /i).map(function (s) { return s.trim(); }).filter(Boolean);
      var matchedDays = [];
      var unknownDays = [];
      requested.forEach(function (r) {
        var m = ALL_WEEKDAYS.find(function (d) { return d.toLowerCase() === r.toLowerCase() || d.toLowerCase().indexOf(r.toLowerCase()) === 0; });
        if (m) { if (matchedDays.indexOf(m) === -1) matchedDays.push(m); } else unknownDays.push(r);
      });
      if (matchedDays.length === 0) return "I couldn't match any of those to a day — use Mon, Tue, Wed, Thu, Fri, Sat, Sun.";
      matchedDays = ALL_WEEKDAYS.filter(function (d) { return matchedDays.indexOf(d) !== -1; });
      setScheduleDays(matchedDays);
      return "Working days set to " + matchedDays.join(", ") + "." + (unknownDays.length ? (" Didn't recognize: " + unknownDays.map(function (u) { return escapeHtml(u); }).join(", ") + ".") : "");
    }

    var assignMatch = raw.match(/^(?:assign|put)\s+(.+?)\s+(?:to|as)\s+(.+?)\s+(?:on|for)\s+(.+)$/i);
    if (assignMatch) {
      var cfgAs = orgConfig();
      var workerFrag = assignMatch[1].trim();
      var dutyFrag = assignMatch[2].trim();
      var dayFrag = assignMatch[3].trim();
      var foundWorker = findWorkerByName(workerFrag);
      if (!foundWorker.match) {
        if (foundWorker.ambiguous) return "That matches more than one person: " + foundWorker.ambiguous.map(function (w) { return escapeHtml(w.name); }).join(", ") + ". Try the full name.";
        return "I couldn't find anyone named \"" + escapeHtml(workerFrag) + "\" on the roster.";
      }
      var matchedDuty = cfgAs.duties.find(function (d) { return d.toLowerCase() === dutyFrag.toLowerCase(); });
      if (!matchedDuty) return "\"" + escapeHtml(dutyFrag) + "\" isn't one of your job types. Valid: " + cfgAs.duties.map(function (d) { return escapeHtml(d); }).join(", ") + ".";

      if (cfgAs.mode === "church") {
        var matchedService = cfgAs.services.find(function (s) { return s.toLowerCase() === dayFrag.toLowerCase(); });
        if (!matchedService) return "\"" + escapeHtml(dayFrag) + "\" isn't one of your services. Valid: " + cfgAs.services.map(function (s) { return escapeHtml(s); }).join(", ") + ".";
        if (!churchAssignments[matchedDuty]) churchAssignments[matchedDuty] = {};
        churchAssignments[matchedDuty][matchedService] = foundWorker.match.id;
        ShiftFlowAPI.setChurchAssignment(matchedDuty, matchedService, foundWorker.match.id).catch(function () {});
        renderSchedule(); renderTodayShifts(); updateStatCards();
        return "Assigned " + escapeHtml(foundWorker.match.name) + " to " + escapeHtml(matchedDuty) + " for " + escapeHtml(matchedService) + ".";
      }
      var matchedDay = ALL_WEEKDAYS.find(function (d) { return d.toLowerCase() === dayFrag.toLowerCase() || d.toLowerCase().indexOf(dayFrag.toLowerCase()) === 0; });
      if (!matchedDay || cfgAs.days.indexOf(matchedDay) === -1) return "\"" + escapeHtml(dayFrag) + "\" isn't one of your working days. Valid: " + cfgAs.days.map(function (d) { return escapeHtml(d); }).join(", ") + ".";
      if (!duties[foundWorker.match.id]) duties[foundWorker.match.id] = {};
      duties[foundWorker.match.id][matchedDay] = matchedDuty;
      ShiftFlowAPI.setDuty(foundWorker.match.id, matchedDay, matchedDuty).catch(function () {});
      renderSchedule(); renderTodayShifts(); updateStatCards();
      return "Assigned " + escapeHtml(foundWorker.match.name) + " to " + escapeHtml(matchedDuty) + " on " + matchedDay + ".";
    }

    var addMatch = raw.match(/^add(?: a)? worker\s+(.+?)\s+as\s+(?:an?\s+)?(.+)$/i);
    if (addMatch) {
      var cfg = orgConfig();
      var name = addMatch[1].trim();
      var roleInput = addMatch[2].trim();
      var matchedRole = cfg.duties.find(function (d) { return d.toLowerCase() === roleInput.toLowerCase(); });
      if (!matchedRole) {
        var validRoles = cfg.duties.map(function (d) { return escapeHtml(d); }).join(", ");
        return "I don't recognize the role \"" + escapeHtml(roleInput) + "\". Valid roles for " + escapeHtml(orgConfig().label) + ": " + validRoles + ".";
      }
      addWorker({ name: name, role: matchedRole, status: "on", email: "" });
      return "Added " + escapeHtml(name) + " as " + escapeHtml(matchedRole) + ". Their sign-in PIN is on their Team card.";
    }

    var removeMatch = raw.match(/^remove(?: worker)?\s+(.+)$|^delete(?: worker)?\s+(.+)$/i);
    if (removeMatch) {
      var target = (removeMatch[1] || removeMatch[2]).trim();
      var found = findWorkerByName(target);
      if (found.match) {
        var removed = removeWorkerDirect(found.match.id);
        return removed ? ("Removed " + escapeHtml(removed.name) + " from the roster.") : "Couldn't remove that worker.";
      }
      if (found.ambiguous) return "That matches more than one person: " + found.ambiguous.map(function (w) { return escapeHtml(w.name); }).join(", ") + ". Try the full name.";
      return "I couldn't find anyone named \"" + escapeHtml(target) + "\" on the roster.";
    }

    var approveIdMatch = lower.match(/approve swap #?(\d+)/);
    var declineIdMatch = lower.match(/decline swap #?(\d+)|reject swap #?(\d+)/);
    if (approveIdMatch || declineIdMatch) {
      var id = Number((approveIdMatch || declineIdMatch)[1] || (declineIdMatch && declineIdMatch[2]));
      var status = approveIdMatch ? "approved" : "declined";
      var swap = swaps.find(function (s) { return s.id === id; });
      if (!swap) return "I don't see a swap request #" + id + ".";
      if (swap.status !== "pending") return "Swap #" + id + " was already " + swap.status + ".";
      resolveSwap(id, status);
      return "Swap #" + id + " (" + escapeHtml(swap.from) + ") " + status + ".";
    }

    var approveNameMatch = lower.match(/approve\s+(.+?)'?s?\s+swap/);
    var declineNameMatch = lower.match(/decline\s+(.+?)'?s?\s+swap|reject\s+(.+?)'?s?\s+swap/);
    if (approveNameMatch || declineNameMatch) {
      var nameFrag = (approveNameMatch ? approveNameMatch[1] : (declineNameMatch[1] || declineNameMatch[2])).trim();
      var statusToSet = approveNameMatch ? "approved" : "declined";
      var candidates = swaps.filter(function (s) { return s.status === "pending" && s.from.toLowerCase().indexOf(nameFrag.toLowerCase()) !== -1; });
      if (candidates.length === 0) return "No pending swap request from \"" + escapeHtml(nameFrag) + "\".";
      if (candidates.length > 1) return "More than one pending request matches — use the ID instead: " + candidates.map(function (s) { return "#" + s.id; }).join(", ") + ".";
      resolveSwap(candidates[0].id, statusToSet);
      return "Swap #" + candidates[0].id + " (" + escapeHtml(candidates[0].from) + ") " + statusToSet + ".";
    }

    if (/auto.?assign|fill open shifts|fill the schedule/.test(lower)) {
      if (team.length === 0) return "Add workers first — auto-assign matches them by role.";
      var cfgA = orgConfig();
      var filled = cfgA.mode === "church" ? autoAssignChurch(cfgA) : autoAssignGrid(cfgA);
      renderSchedule(); renderTodayShifts(); updateStatCards(); renderBarChart();
      return filled === 0 ? "Nothing left to auto-assign — either everything's covered, or no one's role matches the open slots." : ("Auto-assigned " + filled + " open " + (filled === 1 ? "slot" : "slots") + ".");
    }

    var announceMatch = raw.match(/^announce:?\s*(.+?)\s*[—-]\s*(.+)$/i) || raw.match(/^(?:post |create )?announcement:?\s*(.+?)\s*[—-]\s*(.+)$/i);
    if (announceMatch) {
      createAnnouncement(announceMatch[1].trim(), announceMatch[2].trim());
      return "Posted: \"" + escapeHtml(announceMatch[1].trim()) + "\".";
    }
    var announceSimple = raw.match(/^announce:?\s*(.+)$/i);
    if (announceSimple) {
      createAnnouncement("Update", announceSimple[1].trim());
      return "Posted your announcement. Tip: \"announce Title — message\" lets you set a custom title.";
    }

    if (/who'?s on shift|who is working|working today/.test(lower)) {
      var onShift = team.filter(function (w) { return w.on; });
      return onShift.length === 0 ? "No one's marked on-shift right now." : onShift.map(function (w) { return escapeHtml(w.name) + " (" + escapeHtml(w.role) + ")"; }).join(", ");
    }

    return null; // no admin command matched
  }

  // --- Worker-scoped commands ---
  function tryWorkerCommand(raw, lower) {
    if (/^help$|what can you do|what commands/.test(lower)) return HELP_WORKER;

    if (/clock (me )?in/.test(lower)) {
      if (workerClockedIn) return "You're already clocked in.";
      workerClockBtn.click();
      return "Clocked you in at " + timeNow() + ".";
    }
    if (/clock (me )?out/.test(lower)) {
      if (!workerClockedIn) return "You're not clocked in right now.";
      workerClockBtn.click();
      return "Clocked you out at " + timeNow() + ".";
    }

    if (/my role/.test(lower)) return "You're set up as " + escapeHtml(currentWorker.role) + ".";
    if (/my shifts|when do i work/.test(lower)) {
      renderWorkerSwapForm(); // refreshes myShifts list under the hood via renderWorkerShifts already, just ensure fresh
      var shiftSelect = $("#swapRequestShift");
      var options = shiftSelect ? Array.prototype.slice.call(shiftSelect.options).map(function (o) { return o.textContent; }).filter(function (t) { return t && !t.includes("no shifts"); }) : [];
      return options.length === 0 ? "You don't have any shifts assigned yet." : ("Your shifts: " + options.join(", ") + ".");
    }

    if (/request (a )?swap|need (someone|coverage)|cover my shift/.test(lower)) {
      var shiftSelect2 = $("#swapRequestShift");
      var validOptions = shiftSelect2 ? Array.prototype.slice.call(shiftSelect2.options).filter(function (o) { return o.value; }) : [];
      if (validOptions.length === 0) return "You don't have a shift assigned yet to request coverage for.";
      var chosen = validOptions[0].value;
      createSwapRequest({ from: currentWorker.name, fromShift: chosen, to: "Anyone available", toShift: "Awaiting response" });
      renderWorkerSwapList();
      return "Sent a coverage request for " + escapeHtml(chosen) + " to your admin. (Want a specific coworker? Use the Request Swap tab.)";
    }

    return null; // no worker command matched
  }

  function assistantHandle(question) {
    var raw = question.trim();
    var lower = raw.toLowerCase();

    // Try to execute a real action first, scoped to who's logged in.
    var actionResult = null;
    if (accessMode === "admin") actionResult = tryAdminCommand(raw, lower);
    else if (accessMode === "worker" && currentWorker) actionResult = tryWorkerCommand(raw, lower);
    if (actionResult) return actionResult;

    // Fall back to informational, read-only answers.
    if (lower.indexOf("open") !== -1 || lower.indexOf("coverage") !== -1) {
      var open = parseInt($("#statOpenCount").textContent, 10) || 0;
      return open === 0 ? "Everything's covered right now — nice work." : ("You've got " + open + " " + ($("#statOpenLabel").textContent.toLowerCase()) + " right now.");
    }
    if (lower.indexOf("swap") !== -1) {
      var pending = swaps.filter(function (s) { return s.status === "pending"; }).length;
      return pending === 0 ? "No pending swap requests." : (pending + " swap request" + (pending === 1 ? "" : "s") + " waiting on approval.");
    }
    if (lower.indexOf("team") !== -1 || lower.indexOf("worker") !== -1) {
      return team.length === 0 ? "Your roster is empty — add your first worker from the Team tab." : ("You have " + team.length + " people on the roster.");
    }
    return "I didn't catch a command there. Type \"help\" to see what I can do.";
  }

  function sendWidgetMessage() {
    var text = chatWidgetInput.value.trim();
    if (!text) { chatWidgetInput.focus(); return; }
    widgetMessages.push({ text: escapeHtml(text), me: true, time: timeNow() });
    chatWidgetInput.value = "";
    renderWidget();
    window.setTimeout(function () {
      widgetMessages.push({ text: assistantHandle(text), me: false, time: timeNow() });
      renderWidget();
      if (!chatWidget.classList.contains("is-open")) setUnread(unreadCount + 1);
    }, 500);
  }
  if (chatWidgetSendBtn) chatWidgetSendBtn.addEventListener("click", sendWidgetMessage);
  if (chatWidgetInput) chatWidgetInput.addEventListener("keydown", function (e) { if (e.key === "Enter") { e.preventDefault(); sendWidgetMessage(); } });
  if (chatWidgetForm) chatWidgetForm.addEventListener("submit", function (e) { e.preventDefault(); });

  /* ---------------------------------------------
     13. Access control — Admin vs Worker
     The org gate is a one-time setup step. After that, every visit
     asks who's using the app: Admin gets the full dashboard built
     earlier in this file; a Worker signs in with their name + PIN
     (set on their Team card) and gets a small, read-mostly view of
     just their own shifts, clocking, swap requests, chat, and
     announcements. Note: the PIN check happens client-side against
     data already loaded in this page — it's a light UX gate to keep
     casual over-reach out, not a real security boundary.
  --------------------------------------------- */
  var accessMode = null; // "admin" | "worker"
  var currentWorker = null;

  var roleGate = $("#roleGate");
  var workerLoginGate = $("#workerLoginGate");
  var adminAuthGate = $("#adminAuthGate");
  var appEl = $("#app");
  var workerShell = $("#workerShell");
  var roleAdminBtn = $("#roleAdminBtn");
  var roleWorkerBtn = $("#roleWorkerBtn");
  var switchRoleBtn = $("#switchRoleBtn");
  var adminSignOutBtn = $("#adminSignOutBtn");

  function showRoleGate() {
    accessMode = null;
    currentWorker = null;
    roleGate.hidden = false;
    workerLoginGate.hidden = true;
    if (adminAuthGate) adminAuthGate.hidden = true;
    appEl.hidden = true;
    workerShell.hidden = true;
    updateToggleSurface();
  }
  function enterAdmin() {
    accessMode = "admin";
    roleGate.hidden = true;
    workerLoginGate.hidden = true;
    if (adminAuthGate) adminAuthGate.hidden = true;
    appEl.hidden = false;
    workerShell.hidden = true;
    if (adminSignOutBtn) adminSignOutBtn.hidden = !(window.ShiftFlowAuth && window.ShiftFlowAuth.isConfigured());
    updateToggleSurface();
  }

  /* --- Admin sign-in (only active when Supabase auth is configured) --- */
  var adminAuthMode = "signin"; // "signin" | "signup"
  function renderAdminAuthMode() {
    var isSignup = adminAuthMode === "signup";
    $("#adminAuthTitle").textContent = isSignup ? "Create your admin account" : "Sign in";
    $("#adminAuthSub").textContent = isSignup
      ? "This becomes the account that manages your organization's schedule."
      : "Use your admin account to manage this organization's schedule.";
    $("#adminAuthSubmitBtn").textContent = isSignup ? "Create account" : "Sign in";
    $("#adminAuthToggleBtn").textContent = isSignup ? "Already have an account? Sign in" : "No account yet? Create one";
    $("#adminAuthMsg").textContent = "";
  }
  function enterAdminAuthGate() {
    roleGate.hidden = true;
    adminAuthMode = "signin";
    renderAdminAuthMode();
    $("#adminAuthEmail").value = "";
    $("#adminAuthPassword").value = "";
    adminAuthGate.hidden = false;
    updateToggleSurface();
    $("#adminAuthEmail").focus();
  }
  if (roleAdminBtn) {
    roleAdminBtn.addEventListener("click", function () {
      if (window.ShiftFlowAuth && window.ShiftFlowAuth.isConfigured()) {
        enterAdminAuthGate();
      } else {
        enterAdmin();
      }
    });
  }
  var adminAuthToggleBtn = $("#adminAuthToggleBtn");
  if (adminAuthToggleBtn) {
    adminAuthToggleBtn.addEventListener("click", function () {
      adminAuthMode = adminAuthMode === "signup" ? "signin" : "signup";
      renderAdminAuthMode();
    });
  }
  var adminAuthBackBtn = $("#adminAuthBackBtn");
  if (adminAuthBackBtn) adminAuthBackBtn.addEventListener("click", showRoleGate);
  function submitAdminAuth() {
    var email = $("#adminAuthEmail").value.trim();
    var password = $("#adminAuthPassword").value;
    var msg = $("#adminAuthMsg");
    if (!email || !password) { msg.textContent = "Enter an email and password."; return; }
    if (password.length < 6) { msg.textContent = "Password needs to be at least 6 characters."; return; }
    msg.textContent = "Working on it…";
    var action = adminAuthMode === "signup" ? window.ShiftFlowAuth.signUp : window.ShiftFlowAuth.signInWithPassword;
    action(email, password).then(function (result) {
      if (result.error) { msg.textContent = result.error; return; }
      if (result.needsConfirmation) { msg.textContent = "Account created — check your email to confirm it, then sign in."; adminAuthMode = "signin"; renderAdminAuthMode(); return; }
      enterAdmin();
      showToast(adminAuthMode === "signup" ? "Account created — welcome to ShiftFlow." : "Signed in.");
    });
  }
  var adminAuthSubmitBtn = $("#adminAuthSubmitBtn");
  if (adminAuthSubmitBtn) adminAuthSubmitBtn.addEventListener("click", submitAdminAuth);
  var adminAuthForm = $("#adminAuthForm");
  if (adminAuthForm) {
    $all("input", adminAuthForm).forEach(function (input) {
      input.addEventListener("keydown", function (e) { if (e.key === "Enter") { e.preventDefault(); submitAdminAuth(); } });
    });
  }
  if (adminSignOutBtn) {
    adminSignOutBtn.addEventListener("click", function () {
      closeSidebar();
      window.ShiftFlowAuth.signOut().then(showRoleGate);
    });
  }
  function enterWorkerLogin() {
    roleGate.hidden = true;
    populateWorkerLoginSelect();
    $("#workerLoginEmail").value = "";
    workerLoginGate.hidden = false;
    updateToggleSurface();
  }
  function enterWorkerApp(worker) {
    accessMode = "worker";
    currentWorker = worker;
    workerLoginGate.hidden = true;
    appEl.hidden = true;
    workerShell.hidden = false;
    updateToggleSurface();
    $("#workerAppName").textContent = worker.name;
    renderWorkerShifts();
    renderWorkerSwapForm();
    renderWorkerSwapList();
    renderChatThread();
    renderWorkerAnnouncements();
  }

  if (roleWorkerBtn) roleWorkerBtn.addEventListener("click", enterWorkerLogin);
  if (switchRoleBtn) switchRoleBtn.addEventListener("click", function () { closeSidebar(); showRoleGate(); });

  function populateWorkerLoginSelect() {
    var select = $("#workerLoginName");
    var emptyMsg = $("#workerLoginEmptyMsg");
    var form = $("#workerLoginForm");
    select.innerHTML = "";
    if (team.length === 0) {
      emptyMsg.hidden = false;
      form.hidden = true;
      return;
    }
    emptyMsg.hidden = true;
    form.hidden = false;
    team.forEach(function (w) {
      var opt = document.createElement("option");
      opt.value = w.id; opt.textContent = w.name;
      select.appendChild(opt);
    });
  }

  var workerLoginBackBtn = $("#workerLoginBackBtn");
  var workerLoginSubmitBtn = $("#workerLoginSubmitBtn");
  if (workerLoginBackBtn) workerLoginBackBtn.addEventListener("click", function () { workerLoginGate.hidden = true; roleGate.hidden = false; });
  if (workerLoginSubmitBtn) {
    workerLoginSubmitBtn.addEventListener("click", function () {
      var pinField = $("#workerLoginPin");
      var pin = pinField.value.trim();
      var emailField = $("#workerLoginEmail");
      var email = emailField.value.trim().toLowerCase();
      var worker;
      if (email) {
        worker = team.find(function (w) { return (w.email || "").toLowerCase() === email; });
        if (!worker) { showToast("No one on the roster has that email — check with your admin, or pick your name instead.", true); emailField.focus(); return; }
      } else {
        var workerId = $("#workerLoginName").value;
        worker = team.find(function (w) { return String(w.id) === String(workerId); });
        if (!worker) { showToast("Pick your name first.", true); return; }
      }
      if (!pin || pin !== worker.pin) { showToast("That PIN doesn't match — check your Team card with your admin.", true); pinField.focus(); return; }
      pinField.value = "";
      emailField.value = "";
      enterWorkerApp(worker);
    });
  }
  var workerLoginPinField = $("#workerLoginPin");
  if (workerLoginPinField) workerLoginPinField.addEventListener("keydown", function (e) { if (e.key === "Enter") { e.preventDefault(); workerLoginSubmitBtn.click(); } });
  var workerLoginEmailField = $("#workerLoginEmail");
  if (workerLoginEmailField) workerLoginEmailField.addEventListener("keydown", function (e) { if (e.key === "Enter") { e.preventDefault(); workerLoginSubmitBtn.click(); } });

  var workerLogoutBtn = $("#workerLogoutBtn");
  if (workerLogoutBtn) workerLogoutBtn.addEventListener("click", showRoleGate);

  // Worker tab navigation
  var workerTabs = $all(".worker-tab");
  var wviews = $all(".wview");
  workerTabs.forEach(function (tab) {
    tab.addEventListener("click", function () {
      var name = tab.dataset.wview;
      wviews.forEach(function (v) {
        var match = v.id === "wview-" + name;
        v.hidden = !match;
        v.classList.toggle("is-active", match);
      });
      workerTabs.forEach(function (t) { t.classList.toggle("is-active", t === tab); });
    });
  });

  // --- My Shifts (read-only view of this worker's own assignments) ---
  function renderWorkerShifts() {
    var list = $("#workerShiftsList");
    var titleEl = $("#workerShiftsTitle");
    if (!list || !currentWorker) return;
    var cfg = orgConfig();
    list.innerHTML = "";

    if (cfg.mode === "church") {
      titleEl.textContent = "My Sunday assignments";
      var rows = [];
      cfg.duties.forEach(function (duty) {
        cfg.services.forEach(function (service) {
          var assignedId = churchAssignments[duty] && churchAssignments[duty][service];
          if (String(assignedId) === String(currentWorker.id)) rows.push(duty + " · " + service);
        });
      });
      if (rows.length === 0) {
        list.appendChild(el("li", "empty-state", "You're not assigned to anything yet — check back after your admin sets up the schedule."));
        return;
      }
      rows.forEach(function (r) {
        list.appendChild(el("li", "", "<span class='dot dot-on'></span><div><p class='today-name'>" + escapeHtml(r) + "</p></div>"));
      });
    } else {
      titleEl.textContent = "My shifts this week";
      var rows2 = [];
      cfg.days.forEach(function (day) {
        var duty = duties[currentWorker.id] && duties[currentWorker.id][day];
        if (duty && duty !== "Off") rows2.push({ day: day, duty: duty });
      });
      if (rows2.length === 0) {
        list.appendChild(el("li", "empty-state", "Nothing assigned yet — check back after your admin sets up the schedule."));
        return;
      }
      rows2.forEach(function (r) {
        list.appendChild(el("li", "", "<span class='dot dot-on'></span><div><p class='today-name'>" + escapeHtml(r.day) + "</p><p class='today-meta'>" + escapeHtml(r.duty) + "</p></div>"));
      });
    }
  }

  // --- Request Swap (worker creates a coverage request) ---
  function renderWorkerSwapForm() {
    var shiftSelect = $("#swapRequestShift");
    var colleagueSelect = $("#swapRequestColleague");
    if (!shiftSelect || !currentWorker) return;
    var cfg = orgConfig();
    shiftSelect.innerHTML = "";

    var myShifts = [];
    if (cfg.mode === "church") {
      cfg.duties.forEach(function (duty) {
        cfg.services.forEach(function (service) {
          var assignedId = churchAssignments[duty] && churchAssignments[duty][service];
          if (String(assignedId) === String(currentWorker.id)) myShifts.push(duty + " · " + service);
        });
      });
    } else {
      cfg.days.forEach(function (day) {
        var duty = duties[currentWorker.id] && duties[currentWorker.id][day];
        if (duty && duty !== "Off") myShifts.push(day + " · " + duty);
      });
    }
    if (myShifts.length === 0) {
      shiftSelect.innerHTML = "<option value=''>You have no shifts to request coverage for</option>";
    } else {
      myShifts.forEach(function (s) {
        var opt = document.createElement("option");
        opt.value = s; opt.textContent = s;
        shiftSelect.appendChild(opt);
      });
    }

    colleagueSelect.innerHTML = "<option value=''>Anyone available</option>";
    team.filter(function (w) { return w.id !== currentWorker.id; }).forEach(function (w) {
      var opt = document.createElement("option");
      opt.value = w.name; opt.textContent = w.name;
      colleagueSelect.appendChild(opt);
    });
  }

  var swapRequestSubmitBtn = $("#swapRequestSubmitBtn");
  if (swapRequestSubmitBtn) {
    swapRequestSubmitBtn.addEventListener("click", function () {
      var shiftDesc = $("#swapRequestShift").value;
      var colleague = $("#swapRequestColleague").value;
      if (!shiftDesc) { showToast("You don't have a shift to request coverage for yet.", true); return; }
      createSwapRequest({
        from: currentWorker.name,
        fromShift: shiftDesc,
        to: colleague || "Open request",
        toShift: colleague ? "Awaiting response" : "Anyone available"
      });
      renderWorkerSwapList();
      showToast("Request sent to your admin for approval.");
    });
  }

  function renderWorkerSwapList() {
    var list = $("#workerSwapList");
    if (!list || !currentWorker) return;
    list.innerHTML = "";
    var mine = swaps.filter(function (s) { return s.from === currentWorker.name; });
    if (mine.length === 0) {
      list.appendChild(el("div", "empty-state", "You haven't requested any coverage yet."));
      return;
    }
    mine.forEach(function (s) {
      var row = el("div", "swap-card" + (s.status !== "pending" ? " is-resolved" : ""));
      row.innerHTML = "<div class='swap-people'><div><p class='swap-detail-name'>" + escapeHtml(s.fromShift) + "</p><p class='swap-detail-meta'>Requested: " + escapeHtml(s.to) + "</p></div></div>" +
        "<span class='swap-status " + s.status + "'>" + s.status.charAt(0).toUpperCase() + s.status.slice(1) + "</span>";
      list.appendChild(row);
    });
  }

  // --- Announcements (read-only for workers) ---
  function renderWorkerAnnouncements() {
    var list = $("#workerAnnounceList");
    if (!list) return;
    list.innerHTML = "";
    if (announcements.length === 0) {
      list.appendChild(el("div", "empty-state", "No announcements yet."));
      return;
    }
    announcements.forEach(function (a) {
      var card = el("div", "announce-card",
        "<div class='announce-head'><p class='announce-title'>" + escapeHtml(a.title) + "</p><span class='announce-tag'>" + escapeHtml(a.tag || "General") + "</span></div>" +
        "<p class='announce-body'>" + escapeHtml(a.body) + "</p>" +
        "<p class='announce-meta'>" + escapeHtml(a.meta || "Just now") + "</p>"
      );
      list.appendChild(card);
    });
  }

  /* ---------------------------------------------
     Hydrate from backend, then init
  --------------------------------------------- */
  function hydrateFromBackend(data) {
    if (!data) return;
    if (Array.isArray(data.team)) {
      team = data.team;
      nextWorkerId = team.reduce(function (max, w) { return Math.max(max, w.id); }, 0) + 1;
    }
    if (data.duties) duties = data.duties;
    if (data.churchAssignments) churchAssignments = data.churchAssignments;
    if (Array.isArray(data.swaps)) {
      swaps = data.swaps;
      nextSwapId = swaps.reduce(function (max, s) { return Math.max(max, s.id || 0); }, 0) + 1;
    }
    if (Array.isArray(data.attendance)) attendanceLog = data.attendance;
    if (data.chat) chatData = data.chat;
    if (Array.isArray(data.announcements)) announcements = data.announcements;
    if (data.orgType) state.orgType = data.orgType;
    if (Array.isArray(data.scheduleDays)) state.scheduleDays = data.scheduleDays;
    if (Array.isArray(data.jobTypes)) state.jobTypes = data.jobTypes;
  }

  function renderEverything() {
    renderTeam();
    renderSwaps();
    renderAttendance();
    renderChatThread();
    renderAnnouncements();
    renderBarChart();
    updateStatCards();
    if (state.orgType) {
      refreshOrgDependentUI();
    } else {
      renderSchedule();
      renderTodayShifts();
    }
    if (accessMode === "worker" && currentWorker) {
      renderWorkerShifts();
      renderWorkerSwapForm();
      renderWorkerSwapList();
      renderWorkerAnnouncements();
    }
  }

  document.addEventListener("DOMContentLoaded", function () {
    // Render immediately from local (empty) state — never blocks on the network.
    renderEverything();
    renderWidget();
    populateRoleSelect();
    updateToggleSurface();

    // If a backend is reachable, quietly swap in its data on top.
    ShiftFlowAPI.getState().then(function (data) {
      if (!data) return; // no backend, or it timed out — local state stands
      hydrateFromBackend(data);
      renderEverything();
      if (state.orgType) {
        orgGate.classList.add("is-hidden");
        showRoleGate(); // org's already set up — ask whether this visit is admin or worker
        // Already signed in from a previous visit? Skip straight to the
        // dashboard instead of asking them to sign in again.
        if (window.ShiftFlowAuth && window.ShiftFlowAuth.isConfigured()) {
          window.ShiftFlowAuth.getSession().then(function (session) {
            if (session) enterAdmin();
          });
        }
      }
    }).catch(function () { /* local state already rendered */ });
  });
})();
