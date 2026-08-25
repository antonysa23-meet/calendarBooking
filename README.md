# Proto Fab Cal - Lab Session Booking

Booking site for one-off equipment and training sessions in **EDES 210**
(Prototyping and Fabrication) and **BIOE 555** (Prototyping and Fabrication for
Medical Devices), run out of Rice University's Oshman Engineering Design
Kitchen.

Teachers publish a session with a seat cap; students sign in with their
`@rice.edu` Google account and take a seat. The shared course calendar and the
notification emails are handled automatically.

Everything runs on Google Workspace tools the shared course account already
has - there is no server to pay for and nothing to keep running.

---

## How it fits together

```
┌────────────────────┐        HTTPS         ┌─────────────────────────┐
│  GitHub Pages      │  ───────────────────▶│  Apps Script Web App    │
│  static frontend   │   JSON over          │  (runs as the shared    │
│  (frontend/)       │◀───────────────────  │   course Google account)│
└────────────────────┘   text/plain POST    └───────────┬─────────────┘
         │                                              │
         │ Google Identity Services                     │
         ▼                                              ▼
   signed ID token                        ┌──────────┬──────────┬─────────┐
   verified server-side                   │  Sheet   │ Calendar │  Gmail  │
                                          │ (data)   │ (events) │ (mail)  │
                                          └──────────┴──────────┴─────────┘
```

| Piece | What it is |
| --- | --- |
| **Frontend** | Plain HTML/CSS/JS in `frontend/`. No build step, no framework. Served by GitHub Pages. |
| **Backend** | Apps Script Web App in `apps-script/`, deployed *Execute as: Me*, *Access: Anyone*. |
| **Database** | A Google Sheet with `Events`, `Bookings`, `Teachers` and `Courses` tabs. |
| **Identity** | Google Sign-In. Every privileged call carries an ID token that the backend verifies with Google and checks against the `@rice.edu` domain and the `Teachers` allow-list. |
| **Calendar** | A dedicated secondary calendar. Booking adds the student as a guest; cancelling removes them. Google sends the invitations. |
| **Email** | Rice-branded HTML confirmations on top of Calendar's own notifications. |

### Repository layout

```
apps-script/          backend (pushed to Apps Script with clasp)
  Code.js               doGet/doPost router - the seam everything hangs off
  Auth.js               token verification, @rice.edu gate, teacher allow-list
  Events.js             listing + teacher-only create/cancel/roster
  Bookings.js           booking and cancellation, capacity under a script lock
  CalendarService.js    CalendarApp wrappers (guest add/remove, delete)
  EmailService.js       branded HTML email templates and senders
  SheetService.js       generic row CRUD over the spreadsheet
  Constants.js          tab names, column schema, error codes
  Utils.js              response envelopes, dates, escaping
  Setup.js              oneTimeSetup() and maintenance helpers - run by hand
frontend/             the static site (this folder is what Pages publishes)
  index.html book.html my-bookings.html admin.html 404.html
  css/                variables.css (the whole Rice palette), base, components
  js/                 config.js ← the only file you edit after deploying
  assets/             rice-logo.svg (PLACEHOLDER - see step 8)
tests/                Node harness that runs the backend against fake Google
                      services. `npm test`. No deployment needed.
.github/workflows/    Pages deployment
```

---

## Setup - what I need from you

Steps 1–8 need an interactive login to `edes210andbioe555@gmail.com` and cannot
be automated. Everything else is already written and committed.

### 1. Turn on the Apps Script API

Sign in as `edes210andbioe555@gmail.com`, go to
<https://script.google.com/home/usersettings> and switch **Google Apps Script
API** on. Without this, `clasp` cannot push.

### 2. Install clasp and log in

```bash
npm install -g @google/clasp
clasp login          # opens a browser - sign in as the shared account
```

### 3. Create the Apps Script project

From the repository root:

```bash
clasp create --type webapp --title "Proto Fab Cal" --rootDir apps-script
```

That rewrites `.clasp.json` with the real `scriptId`. Then push the code:

```bash
clasp push
```

> If `clasp create` complains that `.clasp.json` already exists, delete the
> placeholder file first - it ships with `PASTE_YOUR_SCRIPT_ID_HERE` in it.

### 4. Create the Sheet and the calendar

```bash
clasp open        # opens the script editor in a browser
```

In the editor, run **`oneTimeSetup`** once (pick it from the function dropdown
and press Run). Approve the permission prompt when it appears - this is the
one-time authorisation for Calendar, Gmail, Sheets and external requests.

It creates the spreadsheet, the four tabs, and a secondary calendar called
*EDES 210 / BIOE 555 - Lab Sessions*, and prints the spreadsheet URL in the log.

> Already have a spreadsheet you want to use? Run
> `oneTimeSetup("<spreadsheetId>")` instead.

### 5. Create the OAuth Client ID

In the Google Cloud project behind the script
(**Project Settings → Google Cloud Platform project** in the Apps Script editor):

1. Configure the **OAuth consent screen** once (External, app name, support
   email - the shared account is fine for all of them).
2. **Credentials → Create credentials → OAuth client ID → Web application.**
3. Under **Authorised JavaScript origins**, add:
   - `https://edes210andbioe555.github.io`
   - `http://localhost:8080` (for local development)

   Origins only - no paths, no trailing slash. This is the single most common
   cause of a sign-in button that silently does nothing.
4. Copy the Client ID and paste it into `SETUP_OAUTH_CLIENT_ID` at the top of
   `apps-script/Setup.js` (see step 7).

### 6. Deploy the Web App

In the editor: **Deploy → New deployment → Web app**

| Setting | Value |
| --- | --- |
| Execute as | **Me** (`edes210andbioe555@gmail.com`) |
| Who has access | **Anyone** |

Copy the `/exec` URL into `APPS_SCRIPT_URL` in `frontend/js/config.js`.

Sanity check: open the `/exec` URL in a browser. It should return
`{"success":true,"data":{"service":"proto-fab-cal",...}}`. Anything else - an
HTML login page, an error - means the deployment settings are wrong.

### 7. Configure the script and add the instructors

**The editor's Run button cannot pass arguments**, so the values live in a block
at the top of `apps-script/Setup.js` instead. Fill in:

```javascript
var SETUP_OAUTH_CLIENT_ID = '....apps.googleusercontent.com';
var SETUP_SITE_URL        = 'https://edes210andbioe555.github.io/calendarBooking/';
var SETUP_TEACHERS = [
  ['jane.doe@rice.edu', 'Jane Doe'],
  ['john.smith@rice.edu', 'John Smith'],
];
```

Then `clasp push`, and run **`configure`** from the editor's function dropdown.
It applies all of it and prints the resulting configuration.

Instructors can also be added later by editing the **Teachers** tab directly
(`email`, `name`, `active` = TRUE) - the sheet is the authority, and that needs
no push or redeploy. `deactivateTeacher(...)` removes access while keeping
their history.

**Anyone not on this list who signs in with an `@rice.edu` account is treated
as a student.** Nobody outside `@rice.edu` can sign in at all.

Finally:

```javascript
showConfig()      // prints every setting and flags anything missing
selfTest()        // creates a test session, books it, tears it down
```

### 8. Replace the placeholder logo

`frontend/assets/rice-logo.svg` is a plain geometric stand-in, not the
university's mark. Download the official wordmark from
<https://brand.rice.edu> and save it over that file (roughly 5:1 aspect ratio
keeps the header spacing). Same for `frontend/assets/favicon.svg`.

### 9. Push to GitHub and turn on Pages

```bash
git init
git add .
git commit -m "Lab session booking site"
git branch -M main
git remote add origin https://github.com/edes210andbioe555/calendarBooking.git
git push -u origin main
```

Then in the repository: **Settings → Pages → Source: GitHub Actions**.
The workflow in `.github/workflows/deploy-pages.yml` publishes `frontend/` on
every push to `main`. The site lands at
`https://edes210andbioe555.github.io/calendarBooking/`.

### 10. Walk through it once for real

With a teacher account and a student account, from the live Pages URL:

- [ ] Publish a session from **Admin**; confirm it appears on the calendar with
      the instructor invited.
- [ ] Book it as a student; confirm the confirmation email **and** the Google
      Calendar invitation both arrive (check spam the first time).
- [ ] Create a **capacity-1** session and try to book it from two accounts at
      once - the second must be refused with "session full".
- [ ] Cancel a booking; confirm the seat frees up and both emails arrive.
- [ ] Cancel a whole session with a couple of bookings; confirm everyone is
      notified and every row is marked cancelled.
- [ ] Sign in with a non-`@rice.edu` account and confirm it is refused.

---

## Day-to-day

### Updating the backend

`clasp push` uploads the code but **does not** move the live URL to it. The
deployment must be updated explicitly:

```bash
clasp push
clasp deployments                       # find the deployment id
clasp deploy -i <deploymentId> -d "what changed"
```

Creating a *new* deployment instead gives you a *new* URL, which then has to be
pasted into `config.js` again. Updating the existing one keeps the URL stable.

### Updating the frontend

Push to `main`. The Actions workflow redeploys Pages. Nothing else to do.

### Running the tests

```bash
npm test          # or: node tests/run-tests.js
```

98 checks covering capacity enforcement, duplicate bookings, booking ownership,
the domain gate, teacher gating, calendar/email side effects and the router's
error envelopes. They run the real `apps-script/` sources against in-memory
fakes of the Google services, so they need no network and no deployment.

### Working on the site locally

```bash
npm run serve       # static server on http://localhost:8080, no dependencies
```

Sign-in only works if `http://localhost:8080` is listed as an authorised
JavaScript origin (step 5).

---

## Things worth knowing

**Email quota.** The shared account is a consumer Gmail account, so custom email
is capped at ~100 recipients per day. Google Calendar's own invitations and
cancellations are separate and unaffected. If the cap is hit, the code logs it,
skips the branded email, and the booking still succeeds - students still get
their calendar invitation. `showConfig()` prints the remaining quota.

**Capacity is never cached.** `seatsRemaining` is recomputed from the `Bookings`
tab on every read, and the booking path runs inside `LockService.getScriptLock()`,
so two students clicking *Book* on the last seat cannot both win. Editing the
Sheet by hand stays consistent for the same reason.

**The Sheet is the source of truth.** If Calendar or Gmail fails, the booking is
still recorded and the response says the calendar was not updated. The reverse
never happens.

**Teachers share responsibility.** Any active teacher can view the roster of,
or cancel, any session - sessions are not locked to whoever created them.

**No waitlist.** Over-capacity bookings are refused with a clear message. Adding
a waitlist later means one more tab and one more branch in `bookSlot_`.

**Times are Central.** The script timezone and the frontend both use
`America/Chicago`, so a session created as 2pm is 2pm at the OEDK regardless of
where the teacher was sitting. Both are configurable
(`apps-script/appsscript.json` and `frontend/js/config.js`).

**Identity comes only from the token.** `Session.getActiveUser()` does not
identify the visitor in a Web App deployed this way - it returns the account the
script runs as. Every caller identity in this codebase comes from the verified
ID token, never from a session API and never from a client-supplied email field.

---

## Troubleshooting

| Symptom | Cause |
| --- | --- |
| Sign-in button does nothing | The Pages origin is missing from **Authorised JavaScript origins** (step 5), or `GOOGLE_CLIENT_ID`/`setOAuthClientId` was never set. |
| "The backend returned a sign-in page instead of data" | The deployment is set to *Who has access: Only myself*. Redeploy with **Anyone**. |
| "This site is not connected to its backend yet" | `APPS_SCRIPT_URL` in `frontend/js/config.js` is still the placeholder. |
| "Token audience mismatch" | `setOAuthClientId(...)` holds a different Client ID than the one the page signs in with. |
| Code changes have no effect on the live site | `clasp push` without `clasp deploy -i <id>`. See *Updating the backend*. |
| "SPREADSHEET_ID is not set" | `oneTimeSetup()` has not been run in this script project. |
| Students get no email but do get the calendar invite | The daily mail quota is exhausted. Check `showConfig()`. |
| Admin tab is hidden for an instructor | Their address is missing from the `Teachers` tab, or `active` is not TRUE. |
