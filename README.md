# ShiftFlow

A shift-scheduling app for businesses, churches, hospitals, schools, hotels,
restaurants, security companies and volunteer teams — with duty rotation,
shift swaps, attendance, team chat, and a small backend that saves everything
to disk.

## Running it for real (with the backend)

No `npm install` needed — the server uses only Node's built-in modules.

```
node server.js
```

Then open **http://localhost:3000** in your browser.

Every action — adding a worker, approving a swap, setting a duty, clocking
in, sending a chat message — is saved to `data.json` in this folder. Stop
and restart the server and everything is still there.

## Running it without the backend

Just open `index.html` directly in a browser. The app still works fully —
it just keeps its data in memory for that browser session instead of on
disk. `api.js` automatically detects whether a backend is reachable and
falls back silently if not.

## Files

| File | Purpose |
|---|---|
| `index.html` | App structure — sidebar, gate, all sections |
| `style.css` | All styling, fully responsive |
| `script.js` | App logic — navigation, schedule, duties, swaps, chat, etc. |
| `api.js` | Talks to the backend; falls back to local data if none is running |
| `server.js` | Dependency-free Node backend + static file server |
| `data.json` | Where the backend persists everything |

## The organization-type picker
(Business, Church, Hospital, School, Hotel, Restaurant, Security Company, or
Volunteer/NGO). It doesn't just relabel things — the schedule's actual
*structure* changes:

- **Church** gets a **Sunday Services** grid: ministry duties (Usher, Greeter,
  Choir, Media & Sound, Parking Team, Children's Ministry, Security) as rows,
  services (First Service, Second Service, Youth Service, Midweek Service) as
  columns. Each cell assigns one team member to that duty for that service.
- **Everyone else** gets a weekly grid: workers as rows, days as columns
  (School is Mon–Fri only; everything else is a full week), with a duty
  dropdown per day so the same person can be Front Desk on Monday and Kitchen
  on Wednesday.

You can change your organization type anytime from "Switch organization
type" at the bottom of the sidebar.

## Schedule setup — customize days/services and job types

The lists above are just starting defaults. On the Schedule tab (Sunday
Services for a church), the **"Schedule setup"** button opens a panel where
you can:

- **Working days** (or **Services**, for a church) — toggle which days show
  up as columns on the grid, or add/rename/remove services. At least one
  must stay active.
- **Job types** — add or remove the duties workers get assigned to. Whatever
  you set here immediately replaces the organization-type defaults
  everywhere: the schedule grid, the Add Worker role picker, auto-assign
  matching, and the assistant's role validation.

"Reset to defaults" puts both lists back to your organization type's
starting values. Switching organization type also resets both, since a
different org type's days/duties usually don't carry over.

## Adding workers

The Team tab's "Add worker" form takes a name, a role, an optional email,
and their current on/off-shift status. The **role you pick here is what
drives auto-assign** (below) — pick whichever of your organization's duty
options actually matches what this person does.

## Auto-assign

On the Schedule tab, **"Auto-assign open shifts"** (or "Auto-assign services"
for a church) fills in every open slot by matching each worker's role to the
duty needed — a Kitchen worker only ever gets assigned to Kitchen, an Usher
only to Usher duty, and so on. When more than one person qualifies for the
same slot, it rotates fairly so no one gets stacked with every shift while
someone else gets none. It only ever fills gaps — anything you've already
assigned by hand is left untouched, and any slot nobody's qualified for is
left open for you to sort out manually.

## How workers get into ShiftFlow

There's no separate app to install — workers use the same URL you do. Every
visit now starts by asking **"How are you using ShiftFlow?"**: Admin, or
"I'm a worker."

- **Admin** goes straight into the full dashboard (everything described
  above).
- **Worker** picks their name from a list and enters a **4-digit PIN**.
  That PIN is generated automatically the moment you add them on the Team
  tab — it's shown right on their team card (with a "New PIN" link if it
  ever needs regenerating), so you just read it off and share it with them.

Once signed in, a worker gets a small, focused view — not the full admin
dashboard:
- **My Shifts** — their own assignments for the week (or this Sunday's
  services, for a church), plus their own clock in/out.
- **Request Swap** — pick one of their own shifts and optionally a specific
  coworker, and it lands in your **Shift Swaps** tab as a pending request
  for you to approve or decline. They can't approve their own or anyone
  else's.
- **Team Chat** and **Announcements** — same shared chat as the admin view,
  read-only announcements.

One important caveat, worth being upfront about: the PIN check happens in
the browser against data the app already has loaded — it's a lightweight
way to keep casual over-reach out (so a worker isn't staring at the full
admin dashboard by accident), not real security. Anyone with access to the
backend's data can see every PIN. If you need this to hold up against
someone actually trying to get in, treat that as a follow-up project, not
something this build claims to solve.

**Getting workers there in practice:** since the whole thing is one URL,
put ShiftFlow behind real hosting (see "Hosting the frontend and backend
separately" below for GitHub Pages + a backend host) and text or email
that link to your team. On a phone, "Add to Home Screen" from the browser
share menu makes it open like an app icon without any install step.

## The floating assistant can actually do things

The chat bubble in the bottom-right isn't just Q&A — it executes real
actions, scoped to whether an admin or a worker is signed in. It's a
rule-based command parser (this is a static app with no server-side model
to call), so it recognizes specific phrasings and runs the same functions
the buttons in the UI use. Type "help" in it any time to see what it
currently understands for your role.

**Admin can say things like:**
- "add worker Sam as Usher"
- "remove worker Sam"
- "assign Sam to Kitchen on Monday" (or "...for First Service" in church mode)
- "mark Sam on shift" / "mark Sam off shift"
- "add job type Delivery Driver" / "remove job type Bar"
- "working days: Mon, Tue, Wed"
- "approve swap 3" or "approve Sam's swap"
- "auto-assign open shifts"
- "announce: Title — message"
- "who's on shift"

**A signed-in worker can say things like:**
- "clock me in" / "clock me out"
- "request a swap"
- "my shifts" / "my role"

A worker's assistant session only has access to worker-level commands —
asking it to remove someone from the roster, for instance, simply won't do
anything, the same way the Team tab isn't in their view at all. When it
doesn't recognize a command, it says so directly instead of guessing at
what you meant.

## Deploying for real (Vercel + Supabase)

`node server.js` is great for trying the app out, but it keeps everything
in one `data.json` file on disk — fine on your own machine, but most hosts
(Vercel included) have a read-only or ephemeral filesystem in production,
so a flat file won't survive a redeploy or even a second server instance.
For an actual deployed instance real people use, swap that file for a real
database:

1. **Create a Supabase project** at [supabase.com](https://supabase.com)
   (free tier is enough for a small team). In the SQL editor, run:
   ```sql
   create table if not exists app_state (
     id text primary key,
     data jsonb not null default '{}'::jsonb,
     updated_at timestamptz not null default now()
   );
   ```
   This one table holds the same data shape `data.json` does — one row per
   deployment.
2. From your Supabase project's **Settings → API**, copy the **Project URL**
   and the **service_role key** (not the `anon` key — the service role key
   is what lets the backend read/write without Supabase's row-level
   security getting in the way, and it's never sent to the browser).
3. **Push this repo to GitHub**, then **import it into Vercel**
   ([vercel.com/new](https://vercel.com/new)) — pick "Other" as the
   framework preset; no build command is needed.
4. In the Vercel project's **Settings → Environment Variables**, add:
   - `SUPABASE_URL` — the Project URL from step 2.
   - `SUPABASE_SERVICE_KEY` — the service_role key from step 2.
   - `RESEND_API_KEY` / `EMAIL_FROM` — optional, for real invite emails
     (see "Turning on real email delivery" below).
5. Deploy. Vercel serves `index.html`/`style.css`/`script.js`/`api.js` as
   static files and runs `api/[...path].js` as a serverless function for
   everything under `/api/*` — same routes `server.js` uses locally, so
   nothing in the frontend needs to change.

`server.js` + `data.json` are still there for local development — running
`node server.js` on your own machine is unaffected by any of this.

**Worth knowing before real people rely on this:** worker PINs are plain
4-digit codes checked in the browser, not hashed or rate-limited — good
enough to keep someone from wandering into the wrong view, not something
that should gate anything sensitive. If that ever needs to hold up against
someone actually trying to get in, treat it as a follow-up, not something
this build claims to solve.

### Hosting the frontend and backend separately

If you instead host the static files somewhere like GitHub Pages and run
the backend elsewhere, set the backend's URL before `api.js` loads. In
`index.html`, uncomment and edit the line already sitting there for this:

```html
<script>window.SHIFTFLOW_API_URL = "https://your-backend.example.com/api";</script>
```

The backend already sends the CORS headers needed for this to work across
origins — you don't need to configure anything else.

## Light and dark mode

There's a toggle (the sun/moon icon, top-right corner) on every screen —
gates, the admin dashboard, and the worker view. It remembers your choice
via `localStorage` and matches your system preference the first time, with
no flash of the wrong theme on load. If storage is blocked (some restricted
preview environments do this), the toggle still works for that session —
it just won't remember your choice on the next visit.

## Inviting a worker

Once you've added someone on the Team tab, their card has two buttons:

- **Copy invite** — copies a ready-to-send message (the app's link, their
  name, and their PIN) to the clipboard. Paste it into a text, WhatsApp,
  Slack — whatever you actually use to reach them.
- **Email invite** — only shows up if you gave them an email address. If
  the deployed backend has real email sending configured (see below), this
  sends the invite straight to their inbox automatically. If not, it falls
  back to opening your own mail client with the message pre-filled — still
  works with zero setup, you just hit send yourself.

Either way, once an invite goes out the worker's card shows an **"Invited"**
badge (hover it to see when), so you can tell at a glance who's actually
been sent their sign-in info and who still needs it.

There's no account creation step for them beyond that — they open the
link, tap "I'm a worker," sign in with their **email + PIN**, or pick their
name from the list and enter the PIN you sent.

### Turning on real email delivery

By default "Email invite" just opens your own mail app — nothing is sent
automatically. To have the server actually deliver the invite when you
click that button:

1. Create a free account at [resend.com](https://resend.com) and grab an
   API key.
2. On whatever host runs `server.js` (Render, Railway, Fly.io, a VPS), set
   two environment variables:
   - `RESEND_API_KEY` — your Resend API key.
   - `EMAIL_FROM` — the "from" address invites are sent from (must be a
     domain you've verified with Resend, or their shared `onboarding@resend.dev`
     sender for testing).
3. Restart the server. No code changes needed — `server.js` picks these up
   from the environment automatically, and falls back to the mailto
   behavior on its own if they're not set.
