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
| `supabase-auth.js` | Optional admin sign-in — no-op until Supabase is configured |
| `server.js` | Dependency-free Node backend + static file server (local dev, single-tenant) |
| `api/[...path].js` | Real deployment backend (Vercel + Supabase, multi-tenant) |
| `data.json` | Where `server.js` persists everything, locally |

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

## Deploying for real (Vercel + Supabase, multi-tenant)

`node server.js` is great for trying the app out on your own machine — one
organization, one `data.json` file, no accounts needed. The real deployment
(`api/[...path].js` on Vercel + Supabase) is a different, bigger thing: it's
multi-tenant — any number of businesses/churches/schools can sign up, each
gets their own admin account and their own completely separate team,
schedule, swaps, attendance, chat and announcements. Nobody sees anybody
else's data.

1. **Create a Supabase project** at [supabase.com](https://supabase.com)
   (free tier is enough for a small team). In the SQL editor, run:
   ```sql
   create table if not exists public.organizations (
     id uuid primary key default gen_random_uuid(),
     owner_id uuid not null references auth.users(id) on delete cascade,
     data jsonb not null default '{}'::jsonb,
     created_at timestamptz not null default now(),
     updated_at timestamptz not null default now()
   );
   create unique index if not exists organizations_owner_idx on public.organizations(owner_id);

   create table if not exists public.worker_invite_tokens (
     token text primary key,
     org_id uuid not null references public.organizations(id) on delete cascade,
     worker_id bigint not null,
     created_at timestamptz not null default now()
   );

   alter table public.organizations enable row level security;
   create policy if not exists organizations_owner_all on public.organizations
     for all using (auth.uid() = owner_id) with check (auth.uid() = owner_id);
   ```
   `organizations` holds one row per admin (their whole team/schedule/etc.
   as one JSONB blob, same shape `data.json` uses locally). The unique
   index enforces one organization per admin account. `worker_invite_tokens`
   is a fast lookup from a worker's personal link back to which
   organization — and which worker — it belongs to. RLS is enabled as a
   safety net (the backend uses the service_role key, which bypasses it
   regardless, so this only matters if the anon key is ever queried
   directly against these tables).
2. In **Authentication → Providers**, make sure **Email** is on (default).
   Optionally turn off "Confirm email" under **Authentication → Settings**
   if you don't want new admins to confirm their address first.
3. From **Settings → API**, copy the **Project URL**, the **anon key**, and
   the **service_role key**.
4. **Push this repo to GitHub**, then **import it into Vercel**
   ([vercel.com/new](https://vercel.com/new)) — pick "Other" as the
   framework preset; no build command is needed.
5. In `index.html`, uncomment and fill in the block already sitting there:
   ```html
   <script>
     window.SHIFTFLOW_SUPABASE_URL = "https://YOUR-PROJECT.supabase.co";
     window.SHIFTFLOW_SUPABASE_ANON_KEY = "YOUR-ANON-KEY";
   </script>
   ```
   The anon key is meant to be public — it identifies the project, it
   doesn't grant access on its own. This is also the switch that turns on
   multi-tenant mode in the frontend: with it set, "Admin" shows a real
   sign-in/create-account screen (first thing, before anything else), and
   the generic "I'm a worker" option disappears — in multi-tenant mode a
   worker only ever arrives through their own personal invite link (see
   below), so there's no generic roster to pick a name from.
6. In the Vercel project's **Settings → Environment Variables**, add:
   - `SUPABASE_URL` — the Project URL from step 3.
   - `SUPABASE_SERVICE_KEY` — the service_role key from step 3 (server-side
     only secret, never sent to the browser).
   - `RESEND_API_KEY` / `EMAIL_FROM` — optional, for real invite emails
     (see "Turning on real email delivery" below).
7. Commit the `index.html` change and deploy. Sign up as an admin, pick
   your organization type, and you're in.

`server.js` + `data.json` are still there for local development, and stay
single-tenant/PIN-based on purpose — it's the zero-config quick-start path,
not a demo of multi-tenancy. Running `node server.js` on your own machine
is unaffected by any of this.

### How workers get in (no PIN, no picking a name)

Each worker gets their own unique link the moment an admin adds them — a
long, unguessable token baked into the URL (`.../?invite=<token>`), copied
or emailed from the Team tab exactly like before. Opening it takes them
straight into their own shifts and clock-in, with no name to pick and no
PIN to type — the link itself is what proves who they are.

That means it should be handled like a password: forward it only to the
worker it belongs to. If a link ever needs to be revoked (a phone was lost,
a message was forwarded to the wrong person), removing that worker from
the Team tab and re-adding them issues a fresh, unrelated token — the old
link stops working immediately.

However a worker got there, they can never reach the admin view — "Admin"
always requires a real Supabase sign-in, and a worker's session never has
one, regardless of what they click or type in the URL.

**Worth knowing:** local dev (`server.js`) still uses the old 4-digit PIN
scheme, since it's a separate, simpler code path meant for trying the app
out, not real teams.

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
