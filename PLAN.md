# Proto Fab Cal — Implementation Plan

## Context

A group of Rice University teachers share one Google account (`edes210andbioe555@gmail.com`) that supports two courses — **EDES 210** (Prototyping and Fabrication, taught through Rice's Oshman Engineering Design Kitchen: laser cutting, 3D printing, CNC/plasma cutting, molding & casting, electronics) and **BIOE 555**. Teachers need to run one-off equipment/training sessions (e.g. "Laser Cutter Safety Training," "3D Printer Orientation") that students book into, with a per-session capacity cap. Today this presumably happens ad hoc; the goal is a small booking platform that:

- Lets teachers **create** these sessions with a capacity cap
- Lets students **browse and book** open seats
- Automatically manages the **shared Google Calendar** (creates the event, adds/removes guests as people book/cancel)
- **Emails** the student and the assigned teacher/professor when a booking happens (in addition to Calendar's own invite emails)
- Is **hosted on GitHub** (frontend) and built entirely on **Google Workspace tools** the shared account already has (Calendar, Gmail, Sheets, Apps Script) — no separate server or paid hosting
- Is visually themed after **Rice's official brand colors + logo**, in the clean academic style of the **EDES 210 course site** (engi210.blogs.rice.edu) and the **iSEED** program under OEDK

The GitHub repo already exists (currently empty): `https://github.com/edes210andbioe555/calendarBooking`. This project directory (`Proto_Fab_Cal`) is the local working copy that will be pushed there.

### Decisions already made (with user sign-off)
- **Backend:** Google Apps Script Web App, deployed from/executing as `edes210andbioe555@gmail.com`, so `CalendarApp`/`GmailApp` calls run natively as that account — no OAuth service-account plumbing needed.
- **Database:** A Google Sheet owned by the same account (Events / Bookings / Teachers / Courses tabs).
- **Frontend:** Static site (plain HTML/CSS/JS, no build step) on **GitHub Pages**, calling the Apps Script Web App as its API.
- **Booking unit:** One-off equipment/training slots (not recurring weekly sections).
- **Auth:** Google Sign-In (Google Identity Services) required for everyone, restricted server-side to `@rice.edu` accounts. The shared `...@gmail.com` account is the *system identity*, not an end-user login. A `Teachers` allow-list (editable in the Sheet) gates the event-creation admin panel; every other signed-in `@rice.edu` user is treated as a student.
- **Branding:** Rice's official palette (Blue `#00205B`, Gray `#7C7E7F`, plus the documented secondary/accent colors) **and** the real Rice logo/wordmark, in a minimal academic layout echoing EDES 210's blog-style site and iSEED's program pages.
- **Event ownership:** Any allow-listed teacher can manage/cancel/view the roster of *any* event (shared-responsibility model, not creator-locked).
- **Email quota:** Accept the consumer-Gmail ~100-recipients/day custom-email cap for now (Calendar's own invite/cancellation emails are separate and unaffected); no Workspace upgrade, no email volume reduction at this stage.
- **Waitlist:** Not building one — over-capacity bookings are simply rejected with a clear "session full" message. Easy future extension if needed later.

---

## Architecture

```
Proto_Fab_Cal/
├── README.md                    # setup steps, architecture summary
├── .gitignore
├── .clasp.json                  # {scriptId, rootDir: "apps-script"}
├── apps-script/
│   ├── appsscript.json          # manifest: webapp config, scopes, timezone
│   ├── Code.js                  # doGet/doPost entry points + action router
│   ├── Auth.js                  # verifyIdToken(), @rice.edu check, teacher allow-list lookup
│   ├── Events.js                # createEvent, listEvents, cancelEvent, getRoster
│   ├── Bookings.js              # bookSlot, cancelBooking, listMyBookings
│   ├── CalendarService.js       # CalendarApp wrappers: booking calendar, addGuest/removeGuest/deleteEvent
│   ├── EmailService.js          # Rice-branded HTML email templates + GmailApp/MailApp senders
│   ├── SheetService.js          # generic row CRUD over SpreadsheetApp
│   ├── Constants.js             # sheet/tab names, column enums, PropertiesService keys
│   ├── Setup.js                 # oneTimeSetup() — creates tabs/headers/calendar, run once manually
│   └── Utils.js                 # jsonResponse(), errorResponse(), uuid(), date helpers
├── frontend/
│   ├── index.html                # Home
│   ├── book.html                 # Browse & Book a Slot
│   ├── my-bookings.html          # My Bookings
│   ├── admin.html                # Create Event / Teacher panel (role-gated)
│   ├── css/variables.css         # Rice palette as CSS custom properties
│   ├── css/base.css              # reset, typography, nav/footer
│   ├── css/components.css        # cards, buttons, badges, forms, modals, tables
│   ├── js/config.js              # APPS_SCRIPT_URL, GOOGLE_CLIENT_ID
│   ├── js/auth.js                # Google Identity Services, token storage, whoAmI
│   ├── js/api.js                 # fetch wrapper (text/plain POST body, JSON parse)
│   ├── js/{home,book,my-bookings,admin}.js
│   └── assets/rice-logo.svg      # placeholder — real asset supplied later
└── .github/workflows/deploy-pages.yml   # Actions-based Pages deploy from frontend/
```

`clasp`'s `.clasp.json` `rootDir: "apps-script"` keeps the frontend out of the Apps Script bundle entirely. Since the frontend lives in a subfolder, GitHub Pages deployment uses the Actions-based flow (`actions/upload-pages-artifact` on `frontend/` → `actions/deploy-pages`), not classic branch deployment.

### Google Sheet schema

- **`Events`**: eventId, courseId, title, sessionType, description, startDateTime, endDateTime, location, capacity, teacherEmail, teacherName, calendarEventId, status (ACTIVE/CANCELLED), createdBy, createdAt. (No cached `bookedCount` as source of truth — capacity is recomputed from `Bookings` under lock each time, to avoid drift.)
- **`Bookings`**: bookingId, eventId, studentEmail, studentName, status (CONFIRMED/CANCELLED), bookedAt, cancelledAt.
- **`Teachers`**: email, name, active, addedAt — the allow-list.
- **`Courses`**: courseId (e.g. `EDES210`, `BIOE555`), courseName, active — keeps the course dropdown extensible without code changes.

### Apps Script API surface

Single Web App URL, split by sensitivity:
- **`doGet`** — public, no-token reads only: `listEvents` (with computed `seatsRemaining`), `listCourses`.
- **`doPost`** — everything with an identity token or a mutation: `whoAmI`, `bookSlot`, `cancelBooking`, `listMyBookings`, `createEvent`, `cancelEvent`, `getRoster`. Body is `Content-Type: text/plain;charset=utf-8` containing a JSON string (avoids CORS-preflight issues Apps Script handles poorly) with `idToken` inside the body, never in a header or query string.

All responses use a consistent envelope `{success, data|error, message}` — Apps Script Web Apps can't return custom HTTP status codes, so the frontend always branches on `success`, never on HTTP status.

**Key logic:**
- `bookSlot`: wraps the check-then-append in `LockService.getScriptLock()` so the capacity cap and double-booking check are atomic across concurrent requests. On success: `CalendarApp` `addGuest(studentEmail)` on the existing event (triggers Calendar's native invite email) + a custom Rice-branded confirmation email to student and teacher via `GmailApp`.
- `cancelBooking`: verifies the caller owns the booking (never trusts a client-supplied student email), `removeGuest()` (triggers Calendar's native cancellation email) + custom cancellation email.
- `createEvent` (teacher-only, server-verified against `Teachers`): creates the Calendar event on a **dedicated secondary calendar** (not the account's personal default), teacher added as a guest.
- `cancelEvent` (any teacher, per the ownership decision above): marks the Sheet rows cancelled and calls `deleteEvent()` once — Calendar automatically notifies every current guest (teacher + all booked students) in one shot.
- `getRoster` (any teacher): lists confirmed students for an event.

**Auth:** Frontend uses Google Identity Services ("Sign In With Google") to get a signed ID token; every privileged call sends it in the POST body. Server-side, Apps Script verifies it via Google's `tokeninfo` endpoint (`UrlFetchApp.fetch('https://oauth2.googleapis.com/tokeninfo?id_token=...')`), checking `aud` (matches our OAuth Client ID), `iss`, `exp`, `email_verified`, and that the email ends in `@rice.edu` (treating the `hd` claim as a secondary signal, not the sole gate). Teacher status is then a separate allow-list lookup. **Apps Script's own `Session.getActiveUser()` does *not* reflect the site visitor** (the Web App runs as "Execute as: Me" / "Anyone" access) — caller identity comes exclusively from the verified token, never session APIs.

### Frontend pages & styling

- `index.html` — hero, Rice logo, sign-in button, nav (Home / Book a Slot / My Bookings / Admin-if-teacher).
- `book.html` — card grid of open sessions (course badge, teacher, date/time, location, seats remaining), Book action with inline `FULL`/`ALREADY_BOOKED` handling.
- `my-bookings.html` — student's upcoming bookings with Cancel (confirm dialog, since it sends real notifications).
- `admin.html` — teacher-only (client-side gated for UX; server-side enforced for security): create-event form + list of all events with roster view and cancel-event actions.
- `css/variables.css` holds the full Rice palette as custom properties (`--rice-blue: #00205B`, `--rice-gray: #7C7E7F`, secondary blues `#ADC7DC #E0E2E6 #9FDDF9 #4D9AD4 #0A509E #13133E #44474F #303B61`, accents `#E9A139 #C04829 #68132E #362E52 #005B50 #00432C #359245 #A5C151`), so the whole theme is centralized and swappable. Layout mirrors EDES 210's minimal white-background/dark-text blog style with a simple top nav.

---

## Manual one-time setup steps (require the user's own interactive login — cannot be done by an assistant)

1. Log into `edes210andbioe555@gmail.com`; enable the Apps Script API for it at `script.google.com/home/usersettings`.
2. Create the Google Sheet under that account (or let `Setup.js`'s `oneTimeSetup()` populate a blank one); note its ID.
3. `clasp login` once (interactive OAuth) as that account, then `clasp create` the Apps Script project under it.
4. Create an OAuth 2.0 Client ID (Web application) in the backing Google Cloud project, with authorized JS origins set to the future `https://<username>.github.io` Pages URL (+ localhost for dev); set up the OAuth consent screen once.
5. First Web App deployment (Deploy → New deployment → Web app, **Execute as: Me**, **Who has access: Anyone**) — triggers a one-time interactive authorization prompt for Calendar/Gmail/Sheets/UrlFetch scopes. Copy the resulting `/exec` URL into `frontend/js/config.js`. Note: later `clasp push`es do **not** move this live URL to new code — each real update needs a new `clasp deploy -i <deploymentId>`.
6. Push the project to the existing GitHub repo (`https://github.com/edes210andbioe555/calendarBooking`, currently empty), set **Settings → Pages → Source: GitHub Actions**.
7. Populate the `Teachers` sheet tab with the real initial allow-list of `@rice.edu` emails.
8. Source the real Rice logo/wordmark file from brand.rice.edu and drop it into `frontend/assets/`, replacing the placeholder.

---

## Build order & verification

1. **Sheets + Calendar skeleton** — run `Setup.js` once; verify tabs/headers exist and the secondary calendar appears.
2. **Core services standalone** — `SheetService`, `CalendarService`, `EmailService`, `Events`, `Bookings`; test via throwaway functions run directly in the Script Editor (no HTTP yet). Verify a test event lands correctly in Calendar with the teacher as guest.
3. **Auth verification in isolation** — validate `verifyIdToken()` against a real token grabbed manually before wiring into the router.
4. **Router + first deploy** — build `Code.js`, deploy, and hit the `/exec` URL directly with `Invoke-RestMethod`/`curl` for `listEvents` and `bookSlot` before any frontend exists.
5. **Frontend scaffold + sign-in only** — verify `whoAmI` round-trips with a real `@rice.edu` account and rejects a non-`@rice.edu` one.
6. **Book a Slot flow** — explicitly test the capacity edge case: a capacity-1 event, two near-simultaneous bookings from two accounts, confirming `LockService` prevents overbooking; confirm duplicate booking by the same student is rejected.
7. **My Bookings + cancellation** — verify Calendar's native cancellation email arrives (check spam folder too) alongside the custom email, and the Sheet row updates.
8. **Admin: create/roster/cancel** — verify Calendar guests match the roster, and cancelling an event with several bookings notifies everyone and marks all rows cancelled.
9. **Styling/branding polish** — drop in the real logo, finish responsive pass.
10. **GitHub Pages pipeline** — push, enable Pages, double-check the OAuth Client ID's authorized origins include the final Pages URL (a common silent sign-in failure).
11. **Full end-to-end pass** with a real teacher account and a real student account from the live Pages URL, including checking `MailApp.getRemainingDailyQuota()`.

### Critical files
- `apps-script/Code.js` — action router, the seam everything else hangs off
- `apps-script/Auth.js` — token verification + `@rice.edu`/teacher gating; the whole security model lives here
- `apps-script/Bookings.js` — atomic capacity enforcement via `LockService`
- `apps-script/CalendarService.js` — Calendar/guest management tied to notifications
- `frontend/js/api.js` — the fetch wrapper implementing the CORS workaround; everything else depends on this being right
