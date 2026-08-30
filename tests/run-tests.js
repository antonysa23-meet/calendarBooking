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
const BulkSessions = require('../frontend/js/bulk-sessions');

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

/**
 * `count` back-to-back slots of `minutes` each, starting `hoursFromNow` out.
 */
function slotList(hoursFromNow, count, minutes = 30) {
  const base = Date.now() + hoursFromNow * 3600000;
  const slots = [];
  for (let i = 0; i < count; i++) {
    const start = new Date(base + i * minutes * 60000);
    const end = new Date(start.getTime() + minutes * 60000);
    slots.push({ startDateTime: start.toISOString(), endDateTime: end.toISOString() });
  }
  return slots;
}

function makeBatch(ctx, slots, overrides = {}) {
  return ctx.createEvents_(Object.assign({
    idToken: tok('prof@rice.edu', 'Prof Ada'),
    courseId: 'EDES210',
    title: 'Laser Cutter Safety Training',
    sessionType: 'Safety Training',
    location: 'OEDK Fabrication Shop',
    capacity: 4,
    slots
  }, overrides));
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

group('planSlots - splitting a window into sessions');
{
  const plan = BulkSessions.planSlots({
    dates: ['2026-09-08'], startTime: '17:00', endTime: '19:00',
    slotMinutes: 30, gapMinutes: 0
  });
  check('5-7pm in 30-minute slots makes 4 sessions', plan.slots.length === 4);
  check('the first slot opens the window',
    plan.slots[0].startTime === '17:00' && plan.slots[0].endTime === '17:30');
  check('the last slot closes it',
    plan.slots[3].startTime === '18:30' && plan.slots[3].endTime === '19:00');
  check('nothing is left over when it divides evenly', plan.leftoverMinutes === 0);

  const uneven = BulkSessions.planSlots({
    dates: ['2026-09-08'], startTime: '17:00', endTime: '19:00', slotMinutes: 45
  });
  check('a partial trailing slot is dropped rather than published short',
    uneven.slots.length === 2 && uneven.slots[1].endTime === '18:30');
  check('the unused remainder is reported so it is not a silent surprise',
    uneven.leftoverMinutes === 30);

  const gapped = BulkSessions.planSlots({
    dates: ['2026-09-08'], startTime: '17:00', endTime: '19:00',
    slotMinutes: 30, gapMinutes: 15
  });
  check('a gap pushes each session later',
    gapped.slots.length === 3 && gapped.slots[1].startTime === '17:45');

  const many = BulkSessions.planSlots({
    dates: ['2026-09-11', '2026-09-08'], startTime: '17:00', endTime: '18:00', slotMinutes: 30
  });
  check('every selected date gets the same slots',
    many.slots.length === 4 && many.perDay === 2);
  check('dates come out chronological however they were picked',
    many.slots[0].date === '2026-09-08' && many.slots[3].date === '2026-09-11');

  const duped = BulkSessions.planSlots({
    dates: ['2026-09-08', '2026-09-08'], startTime: '17:00', endTime: '18:00', slotMinutes: 30
  });
  check('the same date picked twice is not published twice', duped.slots.length === 2);

  check('a window shorter than one session yields nothing and says why',
    BulkSessions.planSlots({
      dates: ['2026-09-08'], startTime: '17:00', endTime: '17:20', slotMinutes: 30
    }).problems.length === 1);

  check('an end before the start is refused',
    BulkSessions.planSlots({
      dates: ['2026-09-08'], startTime: '19:00', endTime: '17:00', slotMinutes: 30
    }).problems.length > 0);

  check('no dates is refused',
    BulkSessions.planSlots({
      dates: [], startTime: '17:00', endTime: '19:00', slotMinutes: 30
    }).problems.length > 0);
}

/* ========================================================================== */

group('date picker - selecting the dates to publish on');
{
  // Enough of a DOM for the picker to render into and receive clicks. Keeping
  // the component's markup generation testable is worth more than the few lines
  // of stub, and it needs no jsdom dependency.
  let handler;
  const mount = { innerHTML: '', addEventListener(type, fn) { if (type === 'click') handler = fn; } };
  const changes = [];
  const picker = BulkSessions.createDatePicker(mount, {
    timeZone: 'America/Chicago',
    onChange: (dates) => changes.push(dates.slice())
  });

  const click = (iso, shiftKey = false) => handler({
    shiftKey,
    target: { closest: (sel) => (sel === '[data-date]' ? { dataset: { date: iso }, disabled: false } : null) }
  });

  const html = mount.innerHTML;
  check('the grid renders a button per day of the month',
    (html.match(/<button[^>]*data-date=/g) || []).length >= 28);
  check('every control is type=button, so the calendar cannot submit the form',
    (html.match(/<button/g) || []).length === (html.match(/type="button"/g) || []).length);
  check('days already past are rendered disabled',
    /data-date="[^"]*"[^>]*disabled/.test(html));

  // "Today" is whatever day the suite runs on, so drive the assertions off a
  // date that is unambiguously in the future rather than a hard-coded one.
  const soon = new Date(Date.now() + 30 * 86400000).toISOString().slice(0, 10);
  const later = new Date(Date.now() + 33 * 86400000).toISOString().slice(0, 10);
  const longAgo = new Date(Date.now() - 30 * 86400000).toISOString().slice(0, 10);

  click(soon);
  check('clicking a date selects it', picker.getSelected().join() === soon);

  click(soon);
  check('clicking it again lets it go', picker.getSelected().length === 0);

  click(soon);
  click(later, true);
  check('shift-click takes the whole run of days', picker.getSelected().length === 4);
  check('the run is chronological',
    picker.getSelected()[0] === soon && picker.getSelected()[3] === later);

  click(longAgo);
  check('a past date cannot be selected even if its button is reachable',
    !picker.getSelected().includes(longAgo));

  click(longAgo, true);
  check('a shift-range reaching into the past is clamped to today onwards',
    !picker.getSelected().some((d) => d < new Date().toISOString().slice(0, 10)));

  const before = changes.length;
  picker.clear();
  check('clear() empties the selection', picker.getSelected().length === 0);
  check('every change is announced to the caller', changes.length === before + 1);
}

/* ========================================================================== */

group('createEvents - bulk publishing');
{
  const { ctx, mocks } = boot();

  check('a student cannot bulk publish',
    codeOf(() => makeBatch(ctx, slotList(24, 4), { idToken: tok('student@rice.edu') }))
      === 'FORBIDDEN');

  const batch = makeBatch(ctx, slotList(24, 4));
  check('four slots publish four sessions', batch.count === 4 && batch.events.length === 4);
  check('four calendar events were created',
    mocks._calendarLog.filter((e) => e.op === 'createEvent').length === 4);
  check('four rows landed on the Events tab', ctx.readRecords_('Events').length === 4);
  check('every session in the batch shares one seriesId',
    !!batch.seriesId && batch.events.every((e) => e.seriesId === batch.seriesId));
  check('each session carries its own eventId',
    new Set(batch.events.map((e) => e.eventId)).size === 4);
  check('the shared fields are copied onto every session',
    batch.events.every((e) => e.capacity === 4 && e.title === 'Laser Cutter Safety Training'));

  const published = mocks._sent.filter((m) => /published/i.test(m.subject));
  check('the instructor gets one digest, not one mail per session',
    published.length === 1 && /^4 sessions published/.test(published[0].subject));
  check('the digest lists the schedule', /\d:\d\d\s*(AM|PM)/i.test(published[0].html));
}

{
  const { ctx, mocks } = boot();
  const single = makeBatch(ctx, slotList(24, 1));
  check('a one-slot batch is just a session, with no series to cancel',
    single.count === 1 && single.seriesId === '' && single.events[0].seriesId === '');
  check('a one-slot batch sends the ordinary singular email',
    mocks._sent.some((m) => m.subject === 'Session published: Laser Cutter Safety Training'));
}

{
  const { ctx } = boot();

  check('a batch over the ceiling is refused',
    codeOf(() => makeBatch(ctx, slotList(24, ctx.MAX_BULK_SESSIONS + 1, 15))) === 'BAD_REQUEST');
  check('nothing was published by the refused batch', ctx.readRecords_('Events').length === 0);

  const withPast = slotList(24, 3).concat([{
    startDateTime: new Date(Date.now() - 7200000).toISOString(),
    endDateTime: new Date(Date.now() - 3600000).toISOString()
  }]);
  check('one past slot rejects the whole batch',
    codeOf(() => makeBatch(ctx, withPast)) === 'BAD_REQUEST');
  check('the good slots of a rejected batch are not published anyway',
    ctx.readRecords_('Events').length === 0);

  const start = new Date(Date.now() + 24 * 3600000);
  const overlapping = [
    { startDateTime: start.toISOString(),
      endDateTime: new Date(start.getTime() + 3600000).toISOString() },
    { startDateTime: new Date(start.getTime() + 1800000).toISOString(),
      endDateTime: new Date(start.getTime() + 5400000).toISOString() }
  ];
  check('slots that overlap each other are refused',
    codeOf(() => makeBatch(ctx, overlapping)) === 'BAD_REQUEST');

  check('an empty slot list is refused',
    codeOf(() => makeBatch(ctx, [])) === 'BAD_REQUEST');
}

{
  // Submitted newest-first; the batch should still come back in time order.
  const { ctx } = boot();
  const batch = makeBatch(ctx, slotList(24, 3).reverse());
  check('sessions are published in chronological order regardless of input order',
    batch.events[0].startDateTime < batch.events[1].startDateTime &&
    batch.events[1].startDateTime < batch.events[2].startDateTime);
}

{
  // The rollback: Calendar accepts three, then refuses the fourth.
  const { ctx, mocks } = boot({ calendarCreateFailsAfter: 3 });
  const code = codeOf(() => makeBatch(ctx, slotList(24, 5)));

  check('a mid-batch calendar failure fails the whole request', code !== null);
  check('no Events row survives a half-finished batch',
    ctx.readRecords_('Events').length === 0);
  check('the calendar events already created are deleted again',
    mocks._calendarEvents.size === 0 &&
    mocks._calendarLog.filter((e) => e.op === 'deleteEvent').length === 3);
  check('nobody is emailed about a batch that was rolled back',
    !mocks._sent.some((m) => /published/i.test(m.subject)));
}

{
  // appendRecords_ has to grow the sheet before it can write past the end.
  const { ctx } = boot({ sheetMaxRows: 3 });
  const batch = makeBatch(ctx, slotList(24, 6));
  check('a batch bigger than the sheet grows it instead of throwing',
    batch.count === 6 && ctx.readRecords_('Events').length === 6);
}

/* ========================================================================== */

group('cancelSeries - calling off a whole batch');
{
  const { ctx, mocks } = boot();
  const batch = makeBatch(ctx, slotList(24, 4));
  ctx.bookSlot_({ idToken: tok('sam@rice.edu', 'Sam Student'),
                  eventId: batch.events[1].eventId });

  // The per-session button still works, and only touches its own session.
  ctx.cancelEvent_({ idToken: tok('ta@rice.edu'), eventId: batch.events[0].eventId });
  check('cancelling one session of a batch leaves the rest alone',
    ctx.listEvents_({}).events.length === 3);

  const before = mocks._sent.length;
  const result = ctx.cancelSeries_({ idToken: tok('prof@rice.edu'), seriesId: batch.seriesId });

  check('the remaining three sessions are cancelled', result.cancelled === 3);
  check('the already-cancelled one is not touched twice',
    ctx.listEvents_({ includePast: 'true', includeCancelled: 'true' })
      .events.filter((e) => e.status === 'CANCELLED').length === 4);
  check('no upcoming sessions are left in the batch', ctx.listEvents_({}).events.length === 0);
  check('the booked student is counted as notified', result.notified === 1);

  const toStudent = mocks._sent.slice(before).filter((m) => m.to === 'sam@rice.edu');
  check('the student gets the ordinary individual cancellation email',
    toStudent.length === 1 && /Session cancelled/i.test(toStudent[0].subject));
  check('the booking is marked cancelled',
    ctx.readRecords_('Bookings').every((b) => String(b.status) === 'CANCELLED'));
  check('the calendar events are gone', mocks._calendarEvents.size === 0);

  check('cancelling the same batch again is a clean NOT_FOUND',
    codeOf(() => ctx.cancelSeries_({ idToken: tok('prof@rice.edu'), seriesId: batch.seriesId }))
      === 'NOT_FOUND');
  check('an unknown seriesId is NOT_FOUND',
    codeOf(() => ctx.cancelSeries_({ idToken: tok('prof@rice.edu'), seriesId: 'ser_nope' }))
      === 'NOT_FOUND');
}

{
  const { ctx } = boot();
  const batch = makeBatch(ctx, slotList(24, 3));
  check('a student cannot cancel a batch',
    codeOf(() => ctx.cancelSeries_({ idToken: tok('student@rice.edu'), seriesId: batch.seriesId }))
      === 'FORBIDDEN');
  check('the batch is untouched after the refused attempt',
    ctx.listEvents_({}).events.length === 3);
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

{
  // Seats are locked once the day of the session arrives - the instructor is
  // already counting on the head count by then.
  const { ctx, mocks } = boot();
  const event = makeEvent(ctx, { capacity: 2 });
  const booking = ctx.bookSlot_({ idToken: tok('sam@rice.edu', 'Sam'), eventId: event.eventId });

  check('a booking for a later day can still be cancelled',
    ctx.listMyBookings_({ idToken: tok('sam@rice.edu') }).upcoming[0].canCancel === true);

  // Pull the session back onto today, leaving the booking untouched.
  const row = ctx.findRecord_('Events', (r) => r.eventId === event.eventId);
  ctx.updateRecord_('Events', row._row, { startDateTime: new Date().toISOString() });

  const before = mocks._sent.length;
  check('on the day of the session cancelling is refused',
    codeOf(() => ctx.cancelBooking_({
      idToken: tok('sam@rice.edu'), bookingId: booking.bookingId
    })) === 'CANCEL_CLOSED');
  check('the seat is still confirmed after the refusal',
    ctx.confirmedBookingsForEvent_(event.eventId).length === 1);
  check('and nobody was emailed about a cancellation', mocks._sent.length === before);
  const mine = ctx.listMyBookings_({ idToken: tok('sam@rice.edu'), includeCancelled: true });
  const listed = mine.upcoming.concat(mine.past)
    .find((b) => b.bookingId === booking.bookingId);
  check('listMyBookings tells the page the seat is locked', listed.canCancel === false);
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
