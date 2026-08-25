/**
 * run-tests.js - runs the real apps-script/ sources against the mocks.
 *
 *   node tests/run-tests.js
 *
 * These cover the rules that are expensive to get wrong: capacity enforcement,
 * duplicate bookings, booking-ownership, the @rice.edu gate, teacher gating,
 * and the calendar/email side effects that fan out to real people.
 */

'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');
const { createMocks } = require('./gas-mocks');

const SRC = path.join(__dirname, '..', 'apps-script');

/* -- tiny test runner ------------------------------------------------------ */

let passed = 0;
let failed = 0;
const failures = [];

function check(label, condition, detail) {
  if (condition) {
    passed++;
    console.log('  ✓ ' + label);
  } else {
    failed++;
    failures.push(label + (detail ? ' - ' + detail : ''));
    console.log('  ✗ ' + label + (detail ? '  (' + detail + ')' : ''));
  }
}

function group(name) {
  console.log('\n' + name);
}

/** Run fn and return the ApiError-style code it failed with, or null. */
function codeOf(fn) {
  try {
    fn();
    return null;
  } catch (e) {
    return e.appErrorCode || ('THREW:' + e.message);
  }
}

/* -- environment ----------------------------------------------------------- */

const CLIENT_ID = 'test-client.apps.googleusercontent.com';

function boot(mockOptions = {}) {
  const mocks = createMocks(Object.assign({
    properties: {
      SPREADSHEET_ID: 'ss_mock',
      CALENDAR_ID: 'cal_mock@group.calendar.google.com',
      OAUTH_CLIENT_ID: CLIENT_ID,
      FROM_NAME: 'OEDK Lab Sessions',
      SITE_URL: 'https://example.github.io/calendarBooking/'
    }
  }, mockOptions));

  const context = vm.createContext(Object.assign({}, mocks));

  // Load in the same spirit as Apps Script: all files share one global scope.
  for (const file of fs.readdirSync(SRC).filter((f) => f.endsWith('.js')).sort()) {
    vm.runInContext(fs.readFileSync(path.join(SRC, file), 'utf8'), context, { filename: file });
  }

  // Create the tabs the way oneTimeSetup would.
  const ss = mocks.SpreadsheetApp.openById('ss_mock');
  const headers = context.SHEET_HEADERS;
  Object.keys(headers).forEach((tab) => context.ensureTab_(ss, tab, headers[tab]));

  // Seed the allow-list and courses.
  context.appendRecord_('Courses', { courseId: 'EDES210', courseName: 'EDES 210', active: true });
  context.appendRecord_('Courses', { courseId: 'BIOE555', courseName: 'BIOE 555', active: true });
  context.appendRecord_('Teachers', {
    email: 'prof@rice.edu', name: 'Prof Ada', active: true, addedAt: new Date().toISOString()
  });
  context.appendRecord_('Teachers', {
    email: 'ta@rice.edu', name: 'TA Grace', active: true, addedAt: new Date().toISOString()
  });
  context.appendRecord_('Teachers', {
    email: 'former@rice.edu', name: 'Former Staff', active: false, addedAt: new Date().toISOString()
  });

  return { ctx: context, mocks };
}

const tok = (email, name) => `tok:${email}:${name || email}`;

function futureIso(hoursFromNow, durationHours = 1) {
  const start = new Date(Date.now() + hoursFromNow * 3600000);
  const end = new Date(start.getTime() + durationHours * 3600000);
  return { startDateTime: start.toISOString(), endDateTime: end.toISOString() };
}

function makeEvent(ctx, overrides = {}) {
  const times = futureIso(24);
  return ctx.createEvent_(Object.assign({
    idToken: tok('prof@rice.edu', 'Prof Ada'),
    courseId: 'EDES210',
    title: 'Laser Cutter Safety Training',
    sessionType: 'Safety Training',
    description: 'Closed-toe shoes required.',
    location: 'OEDK Fabrication Shop',
    capacity: 2,
    startDateTime: times.startDateTime,
    endDateTime: times.endDateTime
  }, overrides)).event;
}

/* ========================================================================== */

group('Auth - domain and token rules');
{
  const { ctx } = boot();

  check('a @rice.edu account is accepted',
    ctx.whoAmI_({ idToken: tok('student@rice.edu', 'Sam Student') }).email === 'student@rice.edu');

  check('a gmail.com account is rejected as FORBIDDEN_DOMAIN',
    codeOf(() => ctx.whoAmI_({ idToken: tok('someone@gmail.com') })) === 'FORBIDDEN_DOMAIN');

  check('a lookalike domain (notrice.edu) is rejected',
    codeOf(() => ctx.whoAmI_({ idToken: tok('sneaky@notrice.edu') })) === 'FORBIDDEN_DOMAIN');

  check('a subdomain-suffix trick (rice.edu.evil.com) is rejected',
    codeOf(() => ctx.whoAmI_({ idToken: tok('sneaky@rice.edu.evil.com') })) === 'FORBIDDEN_DOMAIN');

  check('a missing token is UNAUTHENTICATED',
    codeOf(() => ctx.whoAmI_({})) === 'UNAUTHENTICATED');

  check('a malformed token is UNAUTHENTICATED',
    codeOf(() => ctx.whoAmI_({ idToken: 'garbage' })) === 'UNAUTHENTICATED');

  check('an allow-listed teacher is flagged isTeacher',
    ctx.whoAmI_({ idToken: tok('prof@rice.edu') }).isTeacher === true);

  check('a plain student is not flagged isTeacher',
    ctx.whoAmI_({ idToken: tok('student@rice.edu') }).isTeacher === false);

  check('a deactivated teacher loses instructor status',
    ctx.whoAmI_({ idToken: tok('former@rice.edu') }).isTeacher === false);
}

{
  const { ctx } = boot({ tokenAudienceMismatch: true });
  check('a token minted for another client ID is rejected',
    codeOf(() => ctx.whoAmI_({ idToken: tok('student@rice.edu') })) === 'UNAUTHENTICATED');
}

{
  const { ctx } = boot({ tokenExpired: true });
  check('an expired token is rejected',
    codeOf(() => ctx.whoAmI_({ idToken: tok('student@rice.edu') })) === 'UNAUTHENTICATED');
}

/* ========================================================================== */

group('createEvent - teacher gating and validation');
{
  const { ctx, mocks } = boot();

  check('a student cannot create a session',
    codeOf(() => makeEvent(ctx, { idToken: tok('student@rice.edu') })) === 'FORBIDDEN');

  const event = makeEvent(ctx);
  check('a teacher can create a session', !!event.eventId);
  check('the new session reports full capacity available',
    event.seatsRemaining === 2 && event.bookedCount === 0);
  check('a calendar event was created',
    mocks._calendarLog.some((e) => e.op === 'createEvent'));
  check('the instructor was invited as a guest',
    mocks._calendarLog.find((e) => e.op === 'createEvent').guests.includes('prof@rice.edu'));
  check('the instructor was emailed that the session is live',
    mocks._sent.some((m) => m.to === 'prof@rice.edu' && /published/i.test(m.subject)));

  check('a session in the past is rejected',
    codeOf(() => makeEvent(ctx, {
      startDateTime: new Date(Date.now() - 7200000).toISOString(),
      endDateTime: new Date(Date.now() - 3600000).toISOString()
    })) === 'BAD_REQUEST');

  const bad = futureIso(24);
  check('an end time before the start time is rejected',
    codeOf(() => makeEvent(ctx, {
      startDateTime: bad.endDateTime, endDateTime: bad.startDateTime
    })) === 'BAD_REQUEST');

  check('capacity 0 is rejected',
    codeOf(() => makeEvent(ctx, { capacity: 0 })) === 'BAD_REQUEST');

  check('capacity above the ceiling is rejected',
    codeOf(() => makeEvent(ctx, { capacity: 100000 })) === 'BAD_REQUEST');

  check('an unknown course is rejected',
    codeOf(() => makeEvent(ctx, { courseId: 'MATH101' })) === 'BAD_REQUEST');

  check('a missing title is rejected',
    codeOf(() => makeEvent(ctx, { title: '' })) === 'BAD_REQUEST');

  check('assigning the session to a non-teacher is rejected',
    codeOf(() => makeEvent(ctx, { teacherEmail: 'student@rice.edu' })) === 'BAD_REQUEST');

  const assigned = makeEvent(ctx, { teacherEmail: 'ta@rice.edu' });
  check('assigning the session to another allow-listed teacher works',
    assigned.teacherEmail === 'ta@rice.edu' && assigned.teacherName === 'TA Grace');
}

{
  const { ctx, mocks } = boot({ calendarCreateFails: true });
  check('if Calendar refuses the event, no Events row is left behind',
    codeOf(() => makeEvent(ctx)) !== null && ctx.readRecords_('Events').length === 0);
  void mocks;
}

/* ========================================================================== */

group('bookSlot - capacity, duplicates, side effects');
{
  const { ctx, mocks } = boot();
  const event = makeEvent(ctx, { capacity: 1 });

  const first = ctx.bookSlot_({ idToken: tok('sam@rice.edu', 'Sam Student'), eventId: event.eventId });
  check('the first student gets the seat', !!first.bookingId);
  check('seatsRemaining drops to 0', first.seatsRemaining === 0);
  check('the student was added to the calendar event',
    mocks._calendarLog.some((e) => e.op === 'addGuest' && e.email === 'sam@rice.edu'));
  check('the student got a confirmation email',
    mocks._sent.some((m) => m.to === 'sam@rice.edu' && /Confirmed/i.test(m.subject)));
  check('the instructor was told about the booking',
    mocks._sent.some((m) => m.to === 'prof@rice.edu' && /New booking/i.test(m.subject)));

  check('a second student is refused with EVENT_FULL',
    codeOf(() => ctx.bookSlot_({ idToken: tok('kim@rice.edu'), eventId: event.eventId })) === 'EVENT_FULL');

  check('the same student booking twice is refused with ALREADY_BOOKED',
    codeOf(() => ctx.bookSlot_({ idToken: tok('sam@rice.edu'), eventId: event.eventId })) === 'ALREADY_BOOKED');

  check('only one Bookings row exists after the failed attempts',
    ctx.readRecords_('Bookings').length === 1);

  check('booking a non-existent session is NOT_FOUND',
    codeOf(() => ctx.bookSlot_({ idToken: tok('kim@rice.edu'), eventId: 'evt_nope' })) === 'NOT_FOUND');

  check('booking without signing in is UNAUTHENTICATED',
    codeOf(() => ctx.bookSlot_({ eventId: event.eventId })) === 'UNAUTHENTICATED');

  check('a non-Rice account cannot book',
    codeOf(() => ctx.bookSlot_({ idToken: tok('x@gmail.com'), eventId: event.eventId })) === 'FORBIDDEN_DOMAIN');
}

{
  // Capacity holds when many students pile in - the lock serialises them, so
  // exactly `capacity` bookings should survive however many attempts arrive.
  const { ctx } = boot();
  const event = makeEvent(ctx, { capacity: 3 });
  const outcomes = [];
  for (let i = 1; i <= 10; i++) {
    outcomes.push(codeOf(() =>
      ctx.bookSlot_({ idToken: tok(`s${i}@rice.edu`, `Student ${i}`), eventId: event.eventId })));
  }
  const succeeded = outcomes.filter((o) => o === null).length;
  const full = outcomes.filter((o) => o === 'EVENT_FULL').length;
  check('10 students racing for 3 seats: exactly 3 succeed', succeeded === 3, `got ${succeeded}`);
  check('the other 7 are told the session is full', full === 7, `got ${full}`);
  check('the Bookings tab holds exactly 3 confirmed rows',
    ctx.confirmedBookingsForEvent_(event.eventId).length === 3);
  check('listEvents reports 0 seats remaining',
    ctx.listEvents_({}).events.find((e) => e.eventId === event.eventId).seatsRemaining === 0);
}

{
  const { ctx } = boot({ lockUnavailable: true });
  const ev = { eventId: 'x' };
  check('if the lock cannot be taken, booking fails cleanly with BUSY',
    codeOf(() => ctx.bookSlot_({ idToken: tok('sam@rice.edu'), eventId: ev.eventId })) === 'BUSY');
}

{
  // A booking must survive a Calendar outage: the seat is the Sheet row.
  const { ctx, mocks } = boot({ calendarAddGuestFails: true });
  const event = makeEvent(ctx, { capacity: 2 });
  const result = ctx.bookSlot_({ idToken: tok('sam@rice.edu'), eventId: event.eventId });
  check('a Calendar failure still records the booking', !!result.bookingId);
  check('and the response flags that Calendar was not updated', result.calendarUpdated === false);
  check('the confirmation email is still sent',
    mocks._sent.some((m) => m.to === 'sam@rice.edu'));
}

{
  // Likewise an email outage must not cost the student their seat.
  const { ctx } = boot({ mailFails: true });
  const event = makeEvent(ctx, { capacity: 2 });
  let result = null;
  const code = codeOf(() => {
    result = ctx.bookSlot_({ idToken: tok('sam@rice.edu'), eventId: event.eventId });
  });
  check('an email failure does not fail the booking', code === null && !!result.bookingId);
}

{
  // With the quota exhausted, custom mail is skipped but booking still works.
  const { ctx, mocks } = boot({ mailQuota: 0 });
  const event = makeEvent(ctx, { capacity: 2 });
  const result = ctx.bookSlot_({ idToken: tok('sam@rice.edu'), eventId: event.eventId });
  check('with no mail quota left the seat is still booked', !!result.bookingId);
  check('and no email was attempted', mocks._sent.length === 0);
}

/* ========================================================================== */

group('cancelBooking - ownership and seat release');
{
  const { ctx, mocks } = boot();
  const event = makeEvent(ctx, { capacity: 2 });
  const booking = ctx.bookSlot_({ idToken: tok('sam@rice.edu', 'Sam'), eventId: event.eventId });

  check('another student cannot cancel your booking',
    codeOf(() => ctx.cancelBooking_({
      idToken: tok('kim@rice.edu'), bookingId: booking.bookingId
    })) === 'FORBIDDEN');

  check('even a teacher cannot cancel a student booking through this route',
    codeOf(() => ctx.cancelBooking_({
      idToken: tok('prof@rice.edu'), bookingId: booking.bookingId
    })) === 'FORBIDDEN');

  const before = mocks._sent.length;
  const result = ctx.cancelBooking_({ idToken: tok('sam@rice.edu'), bookingId: booking.bookingId });

  check('the owner can cancel', result.alreadyCancelled === false);
  check('the seat goes back into the pool', result.seatsRemaining === 2);
  check('the student was removed from the calendar event',
    mocks._calendarLog.some((e) => e.op === 'removeGuest' && e.email === 'sam@rice.edu'));
  check('cancellation emails went to the student and the instructor',
    mocks._sent.length - before === 2);

  const again = ctx.cancelBooking_({ idToken: tok('sam@rice.edu'), bookingId: booking.bookingId });
  check('cancelling twice is idempotent, not an error', again.alreadyCancelled === true);

  check('the released seat can be taken by someone else',
    !!ctx.bookSlot_({ idToken: tok('kim@rice.edu'), eventId: event.eventId }).bookingId);

  check('cancelling an unknown booking is NOT_FOUND',
    codeOf(() => ctx.cancelBooking_({
      idToken: tok('sam@rice.edu'), bookingId: 'bkg_nope'
    })) === 'NOT_FOUND');
}

/* ========================================================================== */

group('listMyBookings - scoping to the caller');
{
  const { ctx } = boot();
  const a = makeEvent(ctx, { capacity: 5, title: 'Session A' });
  const b = makeEvent(ctx, { capacity: 5, title: 'Session B' });

  ctx.bookSlot_({ idToken: tok('sam@rice.edu', 'Sam'), eventId: a.eventId });
  ctx.bookSlot_({ idToken: tok('sam@rice.edu', 'Sam'), eventId: b.eventId });
  ctx.bookSlot_({ idToken: tok('kim@rice.edu', 'Kim'), eventId: a.eventId });

  const sam = ctx.listMyBookings_({ idToken: tok('sam@rice.edu') });
  const kim = ctx.listMyBookings_({ idToken: tok('kim@rice.edu') });

  check('a student sees only their own bookings', sam.upcoming.length === 2);
  check('and not anyone else\'s', kim.upcoming.length === 1);
  check('each booking carries its session details',
    !!sam.upcoming[0].event.title && !!sam.upcoming[0].event.whenLabel);

  const bookingId = sam.upcoming[0].bookingId;
  ctx.cancelBooking_({ idToken: tok('sam@rice.edu'), bookingId });

  const after = ctx.listMyBookings_({ idToken: tok('sam@rice.edu') });
  check('a cancelled booking leaves the upcoming list', after.upcoming.length === 1);

  const withHistory = ctx.listMyBookings_({
    idToken: tok('sam@rice.edu'), includeCancelled: true
  });
  check('but is still visible in history when asked for', withHistory.past.length === 1);
}

/* ========================================================================== */

group('getRoster and cancelEvent - instructor actions');
{
  const { ctx, mocks } = boot();
  const event = makeEvent(ctx, { capacity: 5 });
  ctx.bookSlot_({ idToken: tok('sam@rice.edu', 'Sam Student'), eventId: event.eventId });
  ctx.bookSlot_({ idToken: tok('kim@rice.edu', 'Kim Learner'), eventId: event.eventId });

  check('a student cannot read the roster',
    codeOf(() => ctx.getRoster_({ idToken: tok('sam@rice.edu'), eventId: event.eventId })) === 'FORBIDDEN');

  const roster = ctx.getRoster_({ idToken: tok('prof@rice.edu'), eventId: event.eventId });
  check('a teacher sees both students', roster.roster.length === 2);
  check('the roster carries names and addresses',
    roster.roster.every((r) => r.studentEmail && r.studentName));

  check('any teacher can read any session\'s roster (shared responsibility)',
    ctx.getRoster_({ idToken: tok('ta@rice.edu'), eventId: event.eventId }).roster.length === 2);

  check('a student cannot cancel a session',
    codeOf(() => ctx.cancelEvent_({ idToken: tok('sam@rice.edu'), eventId: event.eventId })) === 'FORBIDDEN');

  const calendarEventId = ctx.findRecord_('Events', (r) => r.eventId === event.eventId).calendarEventId;
  const before = mocks._sent.length;
  const cancelled = ctx.cancelEvent_({ idToken: tok('ta@rice.edu'), eventId: event.eventId });

  check('a different teacher can cancel the session', cancelled.notified === 2);
  check('the calendar event was deleted', !mocks._calendarEvents.has(calendarEventId));
  check('every booking row is marked cancelled',
    ctx.confirmedBookingsForEvent_(event.eventId).length === 0);
  check('both students plus the instructor were emailed',
    mocks._sent.length - before === 3);
  check('the session disappears from the public list',
    !ctx.listEvents_({}).events.some((e) => e.eventId === event.eventId));
  check('but is visible with includeCancelled',
    ctx.listEvents_({ includeCancelled: 'true', includePast: 'true' })
      .events.some((e) => e.eventId === event.eventId));

  check('cancelling the same session twice is refused',
    codeOf(() => ctx.cancelEvent_({
      idToken: tok('prof@rice.edu'), eventId: event.eventId
    })) === 'EVENT_CANCELLED');

  check('a cancelled session cannot be booked',
    codeOf(() => ctx.bookSlot_({
      idToken: tok('new@rice.edu'), eventId: event.eventId
    })) === 'EVENT_CANCELLED');
}

/* ========================================================================== */

group('listEvents - filtering and seat maths');
{
  const { ctx } = boot();
  const edes = makeEvent(ctx, { courseId: 'EDES210', title: 'EDES session', capacity: 4 });
  makeEvent(ctx, { courseId: 'BIOE555', title: 'BIOE session', capacity: 4 });

  check('all upcoming sessions are listed by default', ctx.listEvents_({}).events.length === 2);
  check('filtering by course narrows the list',
    ctx.listEvents_({ courseId: 'EDES210' }).events.length === 1);
  check('the course filter is case-insensitive',
    ctx.listEvents_({ courseId: 'edes210' }).events.length === 1);

  ctx.bookSlot_({ idToken: tok('sam@rice.edu'), eventId: edes.eventId });
  const listed = ctx.listEvents_({ courseId: 'EDES210' }).events[0];
  check('bookedCount reflects the booking', listed.bookedCount === 1);
  check('seatsRemaining is capacity minus bookings', listed.seatsRemaining === 3);
  check('a human-readable time label is included', /\d/.test(listed.whenLabel));

  check('sessions are sorted soonest first', (() => {
    const events = ctx.listEvents_({}).events;
    return events.every((e, i) => i === 0 || events[i - 1].startDateTime <= e.startDateTime);
  })());
}

/* ========================================================================== */

group('Router - doGet / doPost envelopes');
{
  const { ctx } = boot();
  const parse = (out) => JSON.parse(out.getContent());

  check('doGet ping responds', parse(ctx.doGet({ parameter: { action: 'ping' } })).success === true);

  check('doGet listEvents responds with an events array',
    Array.isArray(parse(ctx.doGet({ parameter: { action: 'listEvents' } })).data.events));

  check('doGet config exposes the client ID for the frontend',
    parse(ctx.doGet({ parameter: { action: 'config' } })).data.googleClientId === CLIENT_ID);

  const unknown = parse(ctx.doGet({ parameter: { action: 'nope' } }));
  check('an unknown GET action returns UNKNOWN_ACTION, not a crash',
    unknown.success === false && unknown.error === 'UNKNOWN_ACTION');

  const post = (body) => parse(ctx.doPost({ postData: { contents: JSON.stringify(body) } }));

  check('doPost whoAmI round-trips a token',
    post({ action: 'whoAmI', idToken: tok('student@rice.edu') }).data.email === 'student@rice.edu');

  const rejected = post({ action: 'whoAmI', idToken: tok('x@gmail.com') });
  check('a rejected domain comes back as a clean envelope',
    rejected.success === false && rejected.error === 'FORBIDDEN_DOMAIN' && !!rejected.message);

  check('doPost with no action is BAD_REQUEST',
    post({ idToken: tok('student@rice.edu') }).error === 'BAD_REQUEST');

  const malformed = parse(ctx.doPost({ postData: { contents: '{not json' } }));
  check('a malformed body does not leak a stack trace',
    malformed.success === false && !/at |Error:/.test(malformed.message));

  check('an empty request is handled',
    parse(ctx.doPost({})).success === false);

  check('teacher-only actions are refused over POST for students',
    post({ action: 'createEvent', idToken: tok('student@rice.edu'), courseId: 'EDES210' })
      .error === 'FORBIDDEN');

  check('listTeachers is teacher-only',
    post({ action: 'listTeachers', idToken: tok('student@rice.edu') }).error === 'FORBIDDEN');

  check('listTeachers returns the active allow-list for a teacher', (() => {
    const data = post({ action: 'listTeachers', idToken: tok('prof@rice.edu') }).data;
    return data.teachers.length === 2 &&
           !data.teachers.some((t) => t.email === 'former@rice.edu');
  })());
}

/* ========================================================================== */

group('Configuration guards');
{
  const mocks = createMocks({ properties: { OAUTH_CLIENT_ID: CLIENT_ID } });
  const ctx = vm.createContext(Object.assign({}, mocks));
  for (const file of fs.readdirSync(SRC).filter((f) => f.endsWith('.js')).sort()) {
    vm.runInContext(fs.readFileSync(path.join(SRC, file), 'utf8'), ctx, { filename: file });
  }
  check('an unconfigured spreadsheet gives a NOT_CONFIGURED message, not a crash',
    codeOf(() => ctx.listEvents_({})) === 'NOT_CONFIGURED');
}

{
  const mocks = createMocks({ properties: { SPREADSHEET_ID: 'ss_mock', CALENDAR_ID: 'cal_mock@group.calendar.google.com' } });
  const ctx = vm.createContext(Object.assign({}, mocks));
  for (const file of fs.readdirSync(SRC).filter((f) => f.endsWith('.js')).sort()) {
    vm.runInContext(fs.readFileSync(path.join(SRC, file), 'utf8'), ctx, { filename: file });
  }
  check('a missing OAuth client ID is reported clearly',
    codeOf(() => ctx.whoAmI_({ idToken: tok('student@rice.edu') })) === 'NOT_CONFIGURED');
}

/* ========================================================================== */

group('Escaping - untrusted text in emails');
{
  const { ctx, mocks } = boot();
  const event = makeEvent(ctx, {
    capacity: 2,
    title: 'Laser <script>alert(1)</script> Training'
  });
  ctx.bookSlot_({ idToken: tok('sam@rice.edu', 'Sam <b>Student</b>'), eventId: event.eventId });
  const mail = mocks._sent.find((m) => m.to === 'sam@rice.edu');
  check('a script tag in a session title is escaped in the email body',
    mail && !mail.html.includes('<script>') && mail.html.includes('&lt;script&gt;'));
  check('markup in a student name is escaped too',
    mocks._sent.some((m) => m.html.includes('Sam &lt;b&gt;Student&lt;/b&gt;')));
}

/* ========================================================================== */

console.log('\n' + '-'.repeat(64));
console.log(`${passed} passed, ${failed} failed`);
if (failed) {
  console.log('\nFailures:');
  failures.forEach((f) => console.log('  - ' + f));
}
process.exit(failed ? 1 : 0);
