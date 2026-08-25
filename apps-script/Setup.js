/**
 * Setup.js - one-time and occasional maintenance functions.
 *
 * These are meant to be run BY HAND from the Apps Script editor while signed in
 * as edes210andbioe555@gmail.com. None of them are reachable over HTTP.
 *
 * Order of operations after a fresh clasp push:
 *   1. oneTimeSetup()  - creates the Sheet tabs and the calendar
 *   2. fill in the SETUP_* block below, then run configure()
 *   3. showConfig()    - confirm everything is wired up
 *
 * The editor's Run button cannot pass arguments to a function, which is why
 * the values live in the block below instead of in the call. The equivalent
 * argument-taking functions (setOAuthClientId, addTeacher, ...) are further
 * down for anyone driving this from clasp or the Apps Script API.
 */

/* ==========================================================================
   EDIT THIS BLOCK, then run configure() from the toolbar.
   Re-running configure() is safe; blank values are skipped, not cleared.
   ========================================================================== */

/**
 * The Web OAuth Client ID students sign in with.
 * Google Cloud Console -> Credentials -> OAuth client ID (Web application).
 */
var SETUP_OAUTH_CLIENT_ID = '648143527214-494u5qjo18hd47dqp9588fi2i9dstjs1.apps.googleusercontent.com';

/**
 * Public site URL, used for the links inside notification emails.
 * Keep the trailing slash. Leave blank to omit the links entirely.
 */
var SETUP_SITE_URL = 'https://antonysa23-meet.github.io/calendarBooking/';

/**
 * Instructors who get the admin panel, as ['email@rice.edu', 'Display Name'].
 * Only @rice.edu addresses are accepted.
 *
 * You can also add or remove people by editing the Teachers tab of the
 * spreadsheet directly - the sheet is the authority, and no redeploy is needed.
 */
var SETUP_TEACHERS = [
  // CHECK THIS LINE - the name below is a guess and appears in the UI and in
  // every notification email. Correct it before running configure().
  ['as610@rice.edu', 'Antony Saleh'],
  // ['colleague@rice.edu', 'Their Name'],
];

/**
 * Only needed for a standalone script that should use a Sheet you already
 * have. Leave blank for a container-bound script, or when oneTimeSetup()
 * already created one.
 */
var SETUP_SPREADSHEET_ID = '';

/**
 * Apply everything in the block above. Prints a summary and finishes by
 * calling showConfig(), so one run tells you whether the wiring is complete.
 */
function configure() {
  var log = [];

  if (SETUP_SPREADSHEET_ID) {
    setProp_(PROP_KEYS.SPREADSHEET_ID, trimStr_(SETUP_SPREADSHEET_ID));
    log.push('SPREADSHEET_ID set.');
  }

  if (SETUP_OAUTH_CLIENT_ID) {
    setOAuthClientId(SETUP_OAUTH_CLIENT_ID);
    log.push('OAUTH_CLIENT_ID set.');
  } else {
    log.push('SKIPPED OAUTH_CLIENT_ID - sign-in will not work until this is filled in.');
  }

  if (SETUP_SITE_URL) {
    setSiteUrl(SETUP_SITE_URL);
    log.push('SITE_URL set to ' + trimStr_(SETUP_SITE_URL));
  }

  if (SETUP_TEACHERS.length) {
    SETUP_TEACHERS.forEach(function (entry) {
      try {
        log.push('  ' + addTeacher(entry[0], entry[1]));
      } catch (e) {
        log.push('  FAILED ' + entry[0] + ': ' + e.message);
      }
    });
  } else {
    log.push('SKIPPED teachers - nobody has admin access until you add at least one.');
  }

  log.push('');
  log.push('---- current configuration ----');
  var out = log.join('\n') + '\n' + showConfig();
  console.log(out);
  return out;
}

/**
 * Create/repair the four tabs, create the dedicated booking calendar, and seed
 * the Courses and Teachers lists. Safe to re-run: it never deletes anything.
 *
 * @param {string=} existingSpreadsheetId reuse a Sheet you already made;
 *     omit to create a new one (or to keep the one already configured).
 */
function oneTimeSetup(existingSpreadsheetId) {
  var log = [];

  // --- Spreadsheet --------------------------------------------------------
  var ssId = trimStr_(existingSpreadsheetId) || getProp_(PROP_KEYS.SPREADSHEET_ID);
  var ss;

  // If this script is bound to a Sheet and no other one was named, use the
  // container. Without this, a bound script would create a second spreadsheet
  // and quietly leave the one you are looking at empty.
  if (!ssId) {
    var container = null;
    try {
      container = SpreadsheetApp.getActiveSpreadsheet();
    } catch (e) {
      container = null;   // standalone script - nothing to bind to
    }
    if (container) {
      ssId = container.getId();
      log.push('Using the spreadsheet this script is bound to.');
    }
  }

  if (ssId) {
    ss = SpreadsheetApp.openById(ssId);
    log.push('Using existing spreadsheet: ' + ss.getName());
  } else {
    ss = SpreadsheetApp.create('Proto Fab Cal - Booking Data');
    ssId = ss.getId();
    log.push('Created spreadsheet: ' + ss.getUrl());
  }
  setProp_(PROP_KEYS.SPREADSHEET_ID, ssId);

  // --- Tabs ---------------------------------------------------------------
  Object.keys(SHEET_HEADERS).forEach(function (tabName) {
    ensureTab_(ss, tabName, SHEET_HEADERS[tabName]);
    log.push('Tab ready: ' + tabName);
  });

  // A brand new spreadsheet arrives with an empty default sheet; drop it once
  // the real tabs exist.
  var defaultSheet = ss.getSheetByName('Sheet1');
  if (defaultSheet && ss.getSheets().length > 1 && defaultSheet.getLastRow() === 0) {
    ss.deleteSheet(defaultSheet);
    log.push('Removed the empty default Sheet1.');
  }

  // --- Calendar -----------------------------------------------------------
  var calendarId = getProp_(PROP_KEYS.CALENDAR_ID);
  var calendar = calendarId ? CalendarApp.getCalendarById(calendarId) : null;

  if (!calendar) {
    var existing = CalendarApp.getCalendarsByName(CALENDAR_NAME);
    if (existing && existing.length) {
      calendar = existing[0];
      log.push('Reusing calendar: ' + CALENDAR_NAME);
    } else {
      calendar = CalendarApp.createCalendar(CALENDAR_NAME, {
        summary: 'Equipment and training sessions students book through the ' +
                 'EDES 210 / BIOE 555 site.',
        color: CalendarApp.Color.NAVY,
        timeZone: scriptTimeZone_()
      });
      log.push('Created calendar: ' + CALENDAR_NAME);
    }
    setProp_(PROP_KEYS.CALENDAR_ID, calendar.getId());
  } else {
    log.push('Using existing calendar: ' + calendar.getName());
  }

  // --- Seed Courses -------------------------------------------------------
  if (readRecords_(SHEET_NAMES.COURSES).length === 0) {
    appendRecord_(SHEET_NAMES.COURSES, {
      courseId: 'EDES210', courseName: 'EDES 210 - Prototyping and Fabrication', active: true
    });
    appendRecord_(SHEET_NAMES.COURSES, {
      courseId: 'BIOE555', courseName: 'BIOE 555', active: true
    });
    log.push('Seeded Courses with EDES210 and BIOE555.');
  }

  // --- Seed Teachers ------------------------------------------------------
  if (readRecords_(SHEET_NAMES.TEACHERS).length === 0) {
    log.push('Teachers list is EMPTY. Add each instructor with ' +
             'addTeacher("name@rice.edu", "Their Name") - only @' +
             ALLOWED_EMAIL_DOMAIN + ' addresses can sign in.');
  }

  // --- Defaults -----------------------------------------------------------
  if (!getProp_(PROP_KEYS.FROM_NAME)) {
    setProp_(PROP_KEYS.FROM_NAME, DEFAULT_FROM_NAME);
  }

  log.push('');
  log.push('Spreadsheet URL: ' + ss.getUrl());
  log.push('Calendar ID: ' + getProp_(PROP_KEYS.CALENDAR_ID));
  log.push('');
  log.push('NEXT: setOAuthClientId("<your web client id>.apps.googleusercontent.com")');

  var out = log.join('\n');
  console.log(out);
  return out;
}

/** Store the OAuth 2.0 Web Client ID that ID tokens must be issued for. */
function setOAuthClientId(clientId) {
  var value = trimStr_(clientId);
  if (!value || value.indexOf('.apps.googleusercontent.com') === -1) {
    throw new Error('That does not look like a Web OAuth Client ID. It should end in ' +
                    '.apps.googleusercontent.com');
  }
  setProp_(PROP_KEYS.OAUTH_CLIENT_ID, value);
  console.log('OAUTH_CLIENT_ID set.');
  return 'OAUTH_CLIENT_ID set.';
}

/**
 * Store the public site URL so notification emails can link back to it.
 * Include the trailing slash, e.g. https://edes210andbioe555.github.io/calendarBooking/
 */
function setSiteUrl(url) {
  var value = trimStr_(url);
  if (value && value.slice(-1) !== '/') value += '/';
  setProp_(PROP_KEYS.SITE_URL, value);
  console.log('SITE_URL set to: ' + value);
  return value;
}

/** Add (or re-activate) an instructor on the allow-list. */
function addTeacher(email, name) {
  var target = normalizeEmail_(email);
  if (!isAllowedDomain_(target)) {
    throw new Error('Teachers must have an @' + ALLOWED_EMAIL_DOMAIN + ' address. Got: ' + target);
  }

  var existing = findRecord_(SHEET_NAMES.TEACHERS, function (row) {
    return normalizeEmail_(row.email) === target;
  });

  if (existing) {
    updateRecord_(SHEET_NAMES.TEACHERS, existing._row, {
      active: true,
      name: trimStr_(name) || trimStr_(existing.name)
    });
    console.log('Re-activated existing teacher: ' + target);
    return 'Re-activated ' + target;
  }

  appendRecord_(SHEET_NAMES.TEACHERS, {
    email: target,
    name: trimStr_(name) || target,
    active: true,
    addedAt: nowIso_()
  });
  console.log('Added teacher: ' + target);
  return 'Added ' + target;
}

/** Soft-remove an instructor: they keep their history but lose admin access. */
function deactivateTeacher(email) {
  var target = normalizeEmail_(email);
  var existing = findRecord_(SHEET_NAMES.TEACHERS, function (row) {
    return normalizeEmail_(row.email) === target;
  });
  if (!existing) throw new Error('No such teacher: ' + target);
  updateRecord_(SHEET_NAMES.TEACHERS, existing._row, { active: false });
  console.log('Deactivated: ' + target);
  return 'Deactivated ' + target;
}

/** Add a course so it appears in the dropdown, without a code change. */
function addCourse(courseId, courseName) {
  var id = trimStr_(courseId).toUpperCase();
  if (!id) throw new Error('courseId is required.');
  var existing = findRecord_(SHEET_NAMES.COURSES, function (row) {
    return trimStr_(row.courseId).toUpperCase() === id;
  });
  if (existing) {
    updateRecord_(SHEET_NAMES.COURSES, existing._row, {
      active: true,
      courseName: trimStr_(courseName) || trimStr_(existing.courseName)
    });
    return 'Re-activated ' + id;
  }
  appendRecord_(SHEET_NAMES.COURSES, {
    courseId: id,
    courseName: trimStr_(courseName) || id,
    active: true
  });
  return 'Added ' + id;
}

/**
 * Print the current wiring. Run this whenever something behaves oddly - almost
 * every "it stopped working" turns out to be one of these being unset.
 */
function showConfig() {
  var lines = [];
  var ssId = getProp_(PROP_KEYS.SPREADSHEET_ID);
  var calId = getProp_(PROP_KEYS.CALENDAR_ID);
  var clientId = getProp_(PROP_KEYS.OAUTH_CLIENT_ID);

  // Session.getEffectiveUser() needs the userinfo.email scope, which this
  // project deliberately does not request - identity always comes from the
  // verified ID token, never from a session API. Purely a diagnostic, so it
  // degrades rather than taking a scope for one printed line.
  var runningAs = '(not available - userinfo.email scope not requested)';
  try {
    runningAs = Session.getEffectiveUser().getEmail() || runningAs;
  } catch (e) { /* scope not granted; nothing here depends on it */ }
  lines.push('Running as:      ' + runningAs);
  lines.push('Script timezone: ' + scriptTimeZone_());
  lines.push('SPREADSHEET_ID:  ' + (ssId || 'NOT SET  <- run oneTimeSetup()'));
  lines.push('CALENDAR_ID:     ' + (calId || 'NOT SET  <- run oneTimeSetup()'));
  lines.push('OAUTH_CLIENT_ID: ' + (clientId || 'NOT SET  <- run setOAuthClientId(...)'));
  lines.push('SITE_URL:        ' + (getProp_(PROP_KEYS.SITE_URL) || '(not set - emails omit links)'));
  lines.push('FROM_NAME:       ' + (getProp_(PROP_KEYS.FROM_NAME) || DEFAULT_FROM_NAME));

  try {
    lines.push('Mail quota left: ' + MailApp.getRemainingDailyQuota() + ' recipients today');
  } catch (e) {
    lines.push('Mail quota left: (unavailable) ' + e);
  }

  if (ssId) {
    try {
      var ss = SpreadsheetApp.openById(ssId);
      lines.push('Spreadsheet:     ' + ss.getUrl());
      Object.keys(SHEET_HEADERS).forEach(function (tab) {
        var sheet = ss.getSheetByName(tab);
        lines.push('  ' + tab + ': ' + (sheet ? Math.max(0, sheet.getLastRow() - 1) + ' rows' : 'MISSING'));
      });
    } catch (e) {
      lines.push('Spreadsheet:     UNREADABLE - ' + e);
    }
  }

  if (calId) {
    var cal = CalendarApp.getCalendarById(calId);
    lines.push('Calendar:        ' + (cal ? cal.getName() : 'UNREADABLE - check CALENDAR_ID'));
  }

  var out = lines.join('\n');
  console.log(out);
  return out;
}

/**
 * End-to-end smoke test with no HTTP and no real students: creates a session an
 * hour from now, books a fake seat straight through the Sheet, reads the
 * roster back, then cancels and cleans up. Useful right after a deploy.
 *
 * It deliberately does NOT go through requireTeacher_, since there is no ID
 * token in the editor - it exercises the Sheet/Calendar plumbing underneath.
 */
function selfTest() {
  var log = [];
  // Attribute the test session to the first active teacher rather than asking
  // for the userinfo.email scope just to name the running account.
  var firstTeacher = findRecord_(SHEET_NAMES.TEACHERS, function (row) {
    return asBool_(row.active);
  });
  var me = firstTeacher
    ? normalizeEmail_(firstTeacher.email)
    : 'selftest@' + ALLOWED_EMAIL_DOMAIN;
  var start = new Date(Date.now() + 60 * 60 * 1000);
  var end = new Date(Date.now() + 90 * 60 * 1000);
  var calendarEventId = null;
  var eventId = uuid_('evt');

  try {
    calendarEventId = createCalendarEvent_({
      title: 'SELF TEST - safe to ignore',
      startIso: start.toISOString(),
      endIso: end.toISOString(),
      description: 'Created by selfTest(). Deleted automatically.',
      location: 'OEDK',
      guests: []
    });
    log.push('PASS: created calendar event ' + calendarEventId);

    appendRecord_(SHEET_NAMES.EVENTS, {
      eventId: eventId,
      courseId: 'EDES210',
      title: 'SELF TEST - safe to ignore',
      sessionType: 'Safety Training',
      description: 'Automated self test.',
      startDateTime: start.toISOString(),
      endDateTime: end.toISOString(),
      location: 'OEDK',
      capacity: 1,
      teacherEmail: me,
      teacherName: 'Self Test',
      calendarEventId: calendarEventId,
      status: EVENT_STATUS.ACTIVE,
      createdBy: me,
      createdAt: nowIso_()
    });
    log.push('PASS: appended Events row ' + eventId);

    var listed = listEvents_({ courseId: 'EDES210' }).events.filter(function (ev) {
      return ev.eventId === eventId;
    });
    log.push((listed.length === 1 ? 'PASS' : 'FAIL') + ': listEvents returned the test session');
    if (listed.length === 1) {
      log.push((listed[0].seatsRemaining === 1 ? 'PASS' : 'FAIL') +
               ': seatsRemaining is 1 before booking (got ' + listed[0].seatsRemaining + ')');
    }

    appendRecord_(SHEET_NAMES.BOOKINGS, {
      bookingId: uuid_('bkg'),
      eventId: eventId,
      studentEmail: 'selftest@' + ALLOWED_EMAIL_DOMAIN,
      studentName: 'Self Test Student',
      status: BOOKING_STATUS.CONFIRMED,
      bookedAt: nowIso_(),
      cancelledAt: ''
    });
    var after = listEvents_({}).events.filter(function (ev) { return ev.eventId === eventId; })[0];
    log.push((after && after.seatsRemaining === 0 ? 'PASS' : 'FAIL') +
             ': seatsRemaining is 0 after one booking (got ' + (after ? after.seatsRemaining : 'n/a') + ')');

    var roster = confirmedBookingsForEvent_(eventId);
    log.push((roster.length === 1 ? 'PASS' : 'FAIL') + ': roster has 1 student');
  } catch (e) {
    log.push('FAIL: ' + e);
  } finally {
    // Clean up whatever got created.
    try {
      if (calendarEventId) deleteCalendarEvent_(calendarEventId);
      var ss = getSpreadsheet_();
      cleanupTestRows_(ss, SHEET_NAMES.BOOKINGS, 'eventId', eventId);
      cleanupTestRows_(ss, SHEET_NAMES.EVENTS, 'eventId', eventId);
      log.push('Cleaned up test rows and calendar event.');
    } catch (e2) {
      log.push('WARNING: cleanup failed, remove rows for ' + eventId + ' by hand: ' + e2);
    }
  }

  var out = log.join('\n');
  console.log(out);
  return out;
}

/** Delete rows whose named column matches a value. Bottom-up so indexes hold. */
function cleanupTestRows_(spreadsheet, tabName, columnName, value) {
  var sheet = spreadsheet.getSheetByName(tabName);
  if (!sheet) return;
  var rows = readRecords_(tabName, function (row) {
    return trimStr_(row[columnName]) === trimStr_(value);
  });
  rows.map(function (r) { return r._row; })
      .sort(function (a, b) { return b - a; })
      .forEach(function (rowNumber) { sheet.deleteRow(rowNumber); });
}
