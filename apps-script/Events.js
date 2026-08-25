/**
 * Events.js - session listing (public) and teacher-only management actions.
 */

/**
 * Shape an Events row for the wire. `bookedCount` is always passed in by the
 * caller, computed from the Bookings tab - the Events row never stores it.
 */
function toEventDto_(row, bookedCount) {
  var capacity = asInt_(row.capacity, 0);
  var booked = asInt_(bookedCount, 0);
  var startIso = toIso_(row.startDateTime);
  var start = toDate_(row.startDateTime);

  return {
    eventId: trimStr_(row.eventId),
    courseId: trimStr_(row.courseId),
    title: trimStr_(row.title),
    sessionType: trimStr_(row.sessionType),
    description: trimStr_(row.description),
    startDateTime: startIso,
    endDateTime: toIso_(row.endDateTime),
    whenLabel: formatRange_(row.startDateTime, row.endDateTime),
    location: trimStr_(row.location),
    capacity: capacity,
    bookedCount: booked,
    seatsRemaining: Math.max(0, capacity - booked),
    teacherEmail: normalizeEmail_(row.teacherEmail),
    teacherName: trimStr_(row.teacherName),
    status: trimStr_(row.status).toUpperCase() || EVENT_STATUS.ACTIVE,
    isPast: !!(start && start.getTime() < Date.now())
  };
}

/**
 * Public list of sessions with live seat counts.
 *
 * Params (all optional): courseId, includePast, includeCancelled.
 * Defaults to upcoming, active sessions - what students should see.
 */
function listEvents_(params) {
  var p = params || {};
  var courseFilter = trimStr_(p.courseId).toUpperCase();
  var includePast = asBool_(p.includePast);
  var includeCancelled = asBool_(p.includeCancelled);
  var now = Date.now();

  var counts = confirmedCountsByEvent_();

  var rows = readRecords_(SHEET_NAMES.EVENTS, function (row) {
    var status = trimStr_(row.status).toUpperCase() || EVENT_STATUS.ACTIVE;
    if (!includeCancelled && status !== EVENT_STATUS.ACTIVE) return false;
    if (courseFilter && trimStr_(row.courseId).toUpperCase() !== courseFilter) return false;
    if (!includePast) {
      var start = toDate_(row.startDateTime);
      if (!start || start.getTime() < now) return false;
    }
    return true;
  });

  var events = rows.map(function (row) {
    return toEventDto_(row, counts[trimStr_(row.eventId)] || 0);
  });

  events.sort(function (a, b) {
    return String(a.startDateTime).localeCompare(String(b.startDateTime));
  });
  if (includePast) events.reverse();

  return { events: events, count: events.length };
}

/** Active courses, for the filter and the create-event dropdown. */
function listCourses_() {
  var rows = readRecords_(SHEET_NAMES.COURSES, function (row) {
    return asBool_(row.active);
  });
  return {
    courses: rows.map(function (row) {
      return {
        courseId: trimStr_(row.courseId),
        courseName: trimStr_(row.courseName)
      };
    }),
    sessionTypes: SESSION_TYPES
  };
}

/**
 * Create a session (teacher only).
 *
 * Creates the Calendar event on the dedicated booking calendar first: if
 * Calendar rejects it we do not want an orphaned Sheet row that students can
 * book into.
 */
function createEvent_(params) {
  var user = requireTeacher_(params);
  requireParams_(params, ['courseId', 'title', 'startDateTime', 'endDateTime', 'capacity']);

  var courseId = trimStr_(params.courseId).toUpperCase();
  var course = findRecord_(SHEET_NAMES.COURSES, function (row) {
    return trimStr_(row.courseId).toUpperCase() === courseId && asBool_(row.active);
  });
  if (!course) {
    fail_(ERR.BAD_REQUEST, 'Unknown course "' + courseId + '". Add it to the Courses tab first.');
  }

  var start = toDate_(params.startDateTime);
  var end = toDate_(params.endDateTime);
  if (!start || !end) {
    fail_(ERR.BAD_REQUEST, 'Start and end must be valid dates and times.');
  }
  if (end.getTime() <= start.getTime()) {
    fail_(ERR.BAD_REQUEST, 'The end time must be after the start time.');
  }
  if (start.getTime() <= Date.now()) {
    fail_(ERR.BAD_REQUEST, 'Sessions must start in the future.');
  }

  var capacity = asInt_(params.capacity, 0);
  if (capacity < 1 || capacity > MAX_CAPACITY) {
    fail_(ERR.BAD_REQUEST, 'Capacity must be between 1 and ' + MAX_CAPACITY + ' seats.');
  }

  // The session may be assigned to another instructor, but only to one who is
  // actually on the allow-list - this field ends up receiving notification mail.
  var teacherEmail = normalizeEmail_(params.teacherEmail) || user.email;
  var teacherName = trimStr_(params.teacherName, 120);
  if (teacherEmail !== user.email) {
    var teacherRow = findRecord_(SHEET_NAMES.TEACHERS, function (row) {
      return normalizeEmail_(row.email) === teacherEmail && asBool_(row.active);
    });
    if (!teacherRow) {
      fail_(ERR.BAD_REQUEST,
        teacherEmail + ' is not on the Teachers list, so this session cannot be assigned to them.');
    }
    if (!teacherName) teacherName = trimStr_(teacherRow.name, 120) || teacherEmail;
  } else if (!teacherName) {
    teacherName = user.name;
  }

  var title = trimStr_(params.title, 150);
  var sessionType = trimStr_(params.sessionType, 60);
  var description = trimStr_(params.description, 2000);
  var location = trimStr_(params.location, 200);

  var calendarDescription =
    (description ? description + '\n\n' : '') +
    courseId + (sessionType ? ' - ' + sessionType : '') + '\n' +
    'Instructor: ' + teacherName + ' (' + teacherEmail + ')\n' +
    'Capacity: ' + capacity + ' seats\n' +
    'Booked through the EDES 210 / BIOE 555 lab session site.';

  var calendarEventId = createCalendarEvent_({
    title: courseId + ': ' + title,
    startIso: start.toISOString(),
    endIso: end.toISOString(),
    description: calendarDescription,
    location: location,
    guests: [teacherEmail]
  });

  var record = {
    eventId: uuid_('evt'),
    courseId: courseId,
    title: title,
    sessionType: sessionType,
    description: description,
    startDateTime: start.toISOString(),
    endDateTime: end.toISOString(),
    location: location,
    capacity: capacity,
    teacherEmail: teacherEmail,
    teacherName: teacherName,
    calendarEventId: calendarEventId,
    status: EVENT_STATUS.ACTIVE,
    createdBy: user.email,
    createdAt: nowIso_()
  };

  try {
    appendRecord_(SHEET_NAMES.EVENTS, record);
  } catch (e) {
    // Do not leave a calendar event nobody can book into.
    deleteCalendarEvent_(calendarEventId);
    throw e;
  }

  var dto = toEventDto_(record, 0);
  sendEventCreatedEmail_(dto, user.email);
  return { event: dto };
}

/**
 * Cancel a whole session (any teacher - shared-responsibility model).
 *
 * Deletes the Calendar event once, which makes Calendar notify every current
 * guest (the instructor and every booked student) in a single pass; that is why
 * guests are not removed one by one first.
 */
function cancelEvent_(params) {
  var user = requireTeacher_(params);
  requireParams_(params, ['eventId']);
  var eventId = trimStr_(params.eventId);

  var eventRow = null;
  var students = [];

  var lock = LockService.getScriptLock();
  if (!lock.tryLock(LOCK_TIMEOUT_MS)) {
    fail_(ERR.BUSY, 'The booking system is busy right now. Please try again in a moment.');
  }

  try {
    eventRow = findRecord_(SHEET_NAMES.EVENTS, function (row) {
      return trimStr_(row.eventId) === eventId;
    });
    if (!eventRow) {
      fail_(ERR.NOT_FOUND, 'That session could not be found.');
    }
    if (trimStr_(eventRow.status).toUpperCase() === EVENT_STATUS.CANCELLED) {
      fail_(ERR.EVENT_CANCELLED, 'That session is already cancelled.');
    }

    var bookings = confirmedBookingsForEvent_(eventId);
    students = bookings.map(function (row) {
      return {
        email: normalizeEmail_(row.studentEmail),
        name: trimStr_(row.studentName) || normalizeEmail_(row.studentEmail)
      };
    });

    var cancelledAt = nowIso_();
    updateRecord_(SHEET_NAMES.EVENTS, eventRow._row, { status: EVENT_STATUS.CANCELLED });
    bulkUpdateRecords_(
      SHEET_NAMES.BOOKINGS,
      bookings.map(function (row) { return row._row; }),
      { status: BOOKING_STATUS.CANCELLED, cancelledAt: cancelledAt }
    );
  } finally {
    lock.releaseLock();
  }

  var calendarUpdated = deleteCalendarEvent_(eventRow.calendarEventId);
  var dto = toEventDto_(eventRow, students.length);
  sendEventCancelledEmails_(dto, students, user.email);

  return {
    eventId: eventId,
    notified: students.length,
    calendarUpdated: calendarUpdated
  };
}

/** Confirmed roster for one session (any teacher). */
function getRoster_(params) {
  requireTeacher_(params);
  requireParams_(params, ['eventId']);
  var eventId = trimStr_(params.eventId);

  var eventRow = findRecord_(SHEET_NAMES.EVENTS, function (row) {
    return trimStr_(row.eventId) === eventId;
  });
  if (!eventRow) {
    fail_(ERR.NOT_FOUND, 'That session could not be found.');
  }

  var bookings = confirmedBookingsForEvent_(eventId);
  bookings.sort(function (a, b) {
    return String(toIso_(a.bookedAt)).localeCompare(String(toIso_(b.bookedAt)));
  });

  return {
    event: toEventDto_(eventRow, bookings.length),
    roster: bookings.map(function (row) {
      return {
        bookingId: trimStr_(row.bookingId),
        studentName: trimStr_(row.studentName),
        studentEmail: normalizeEmail_(row.studentEmail),
        bookedAt: toIso_(row.bookedAt)
      };
    })
  };
}
