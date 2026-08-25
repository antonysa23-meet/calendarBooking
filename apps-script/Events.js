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
    seriesId: trimStr_(row.seriesId),
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

/* -------------------------------------------------------------------------- *
 * Creating sessions
 *
 * createEvent_ and createEvents_ are the same operation at different sizes, so
 * every rule - course, instructor, capacity, timing - lives in createEvents_
 * and the single-session entry point is a one-slot call into it. Two copies of
 * these checks would eventually disagree with each other.
 * -------------------------------------------------------------------------- */

/**
 * Resolve the fields every session in a batch shares. Throws BAD_REQUEST on
 * anything the teacher is not allowed to publish.
 */
function resolveSessionDefaults_(params, user) {
  var courseId = trimStr_(params.courseId).toUpperCase();
  var course = findRecord_(SHEET_NAMES.COURSES, function (row) {
    return trimStr_(row.courseId).toUpperCase() === courseId && asBool_(row.active);
  });
  if (!course) {
    fail_(ERR.BAD_REQUEST, 'Unknown course "' + courseId + '". Add it to the Courses tab first.');
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

  return {
    courseId: courseId,
    capacity: capacity,
    teacherEmail: teacherEmail,
    teacherName: teacherName,
    title: trimStr_(params.title, 150),
    sessionType: trimStr_(params.sessionType, 60),
    description: trimStr_(params.description, 2000),
    location: trimStr_(params.location, 200)
  };
}

/**
 * Validate the requested time slots and hand them back in chronological order.
 *
 * Every slot is checked before a single calendar event is created: a batch that
 * is going to be rejected should be rejected while doing so is still free.
 */
function readSlots_(slots) {
  if (!slots || !slots.length) {
    fail_(ERR.BAD_REQUEST, 'No session times were given.');
  }
  if (slots.length > MAX_BULK_SESSIONS) {
    fail_(ERR.BAD_REQUEST,
      'That batch has ' + slots.length + ' sessions. Publish at most ' + MAX_BULK_SESSIONS +
      ' at a time, then run a second batch for the rest.');
  }

  var total = slots.length;
  function label(index) {
    return total === 1 ? 'This session' : 'Session ' + (index + 1) + ' of ' + total;
  }

  var parsed = slots.map(function (slot, i) {
    var start = toDate_(slot && slot.startDateTime);
    var end = toDate_(slot && slot.endDateTime);
    if (!start || !end) {
      fail_(ERR.BAD_REQUEST, label(i) + ': start and end must be valid dates and times.');
    }
    if (end.getTime() <= start.getTime()) {
      fail_(ERR.BAD_REQUEST, label(i) + ': the end time must be after the start time.');
    }
    if (start.getTime() <= Date.now()) {
      fail_(ERR.BAD_REQUEST, total === 1
        ? 'Sessions must start in the future.'
        : label(i) + ' (' + formatRange_(start, end) + ') is in the past. ' +
          'Sessions must start in the future.');
    }
    return { start: start, end: end };
  });

  parsed.sort(function (a, b) { return a.start.getTime() - b.start.getTime(); });

  // Sorted, so an overlap can only be with the slot immediately before.
  for (var i = 1; i < parsed.length; i++) {
    if (parsed[i].start.getTime() < parsed[i - 1].end.getTime()) {
      fail_(ERR.BAD_REQUEST,
        'Two sessions in this batch overlap: ' +
        formatRange_(parsed[i - 1].start, parsed[i - 1].end) + ' and ' +
        formatRange_(parsed[i].start, parsed[i].end) + '.');
    }
  }

  return parsed;
}

/** The calendar event body, which doubles as what a guest sees in Calendar. */
function sessionCalendarDescription_(defaults) {
  return (defaults.description ? defaults.description + '\n\n' : '') +
    defaults.courseId + (defaults.sessionType ? ' - ' + defaults.sessionType : '') + '\n' +
    'Instructor: ' + defaults.teacherName + ' (' + defaults.teacherEmail + ')\n' +
    'Capacity: ' + defaults.capacity + ' seats\n' +
    'Booked through the EDES 210 / BIOE 555 lab session site.';
}

/**
 * Publish one or many sessions as a single all-or-nothing operation (teacher
 * only).
 *
 * Calendar events are created before the Sheet rows: if Calendar rejects one we
 * do not want orphaned rows students can book into. The mirror-image orphan -
 * calendar events with no row behind them - is why every event this call
 * created is deleted again if any later step fails. A half-published batch is
 * worse than a failed one, because the obvious response to a failure is to
 * republish, and that would double up whatever did land.
 *
 * Params: courseId, title, capacity (plus optional sessionType, description,
 * location, teacherEmail/teacherName) shared by the whole batch, and
 * slots - an array of {startDateTime, endDateTime}.
 */
function createEvents_(params) {
  var user = requireTeacher_(params);
  requireParams_(params, ['courseId', 'title', 'capacity']);

  var defaults = resolveSessionDefaults_(params, user);
  var slots = readSlots_(params.slots);
  var isBatch = slots.length > 1;

  // A batch is tagged so the whole thing can be cancelled in one go later. A
  // lone session gets no series - there is nothing to group it with.
  var seriesId = isBatch ? uuid_('ser') : '';
  var calendarDescription = sessionCalendarDescription_(defaults);
  var createdAt = nowIso_();

  var calendarEventIds = [];
  var records = [];

  try {
    slots.forEach(function (slot) {
      var calendarEventId = createCalendarEvent_({
        title: defaults.courseId + ': ' + defaults.title,
        startIso: slot.start.toISOString(),
        endIso: slot.end.toISOString(),
        description: calendarDescription,
        location: defaults.location,
        guests: [defaults.teacherEmail]
      });
      calendarEventIds.push(calendarEventId);

      records.push({
        eventId: uuid_('evt'),
        seriesId: seriesId,
        courseId: defaults.courseId,
        title: defaults.title,
        sessionType: defaults.sessionType,
        description: defaults.description,
        startDateTime: slot.start.toISOString(),
        endDateTime: slot.end.toISOString(),
        location: defaults.location,
        capacity: defaults.capacity,
        teacherEmail: defaults.teacherEmail,
        teacherName: defaults.teacherName,
        calendarEventId: calendarEventId,
        status: EVENT_STATUS.ACTIVE,
        createdBy: user.email,
        createdAt: createdAt
      });
    });

    appendRecords_(SHEET_NAMES.EVENTS, records);
  } catch (e) {
    calendarEventIds.forEach(function (id) { deleteCalendarEvent_(id); });
    if (!isBatch) throw e;
    fail_((e && e.appErrorCode) || ERR.INTERNAL,
      'Nothing was published. Session ' + Math.min(records.length + 1, slots.length) +
      ' of ' + slots.length + ' could not be created: ' + (e && e.message ? e.message : e));
  }

  var events = records.map(function (record) { return toEventDto_(record, 0); });

  // One digest rather than one mail per session: a 30-session batch would
  // otherwise eat a third of the account's daily recipient allowance.
  if (isBatch) {
    sendEventsCreatedEmail_(events, user.email);
  } else {
    sendEventCreatedEmail_(events[0], user.email);
  }

  return { events: events, seriesId: seriesId, count: events.length };
}

/**
 * Create a single session (teacher only). A thin wrapper over createEvents_ so
 * the rules only exist in one place.
 */
function createEvent_(params) {
  var p = params || {};
  requireTeacher_(p);
  requireParams_(p, ['courseId', 'title', 'startDateTime', 'endDateTime', 'capacity']);

  var single = {};
  Object.keys(p).forEach(function (key) { single[key] = p[key]; });
  single.slots = [{ startDateTime: p.startDateTime, endDateTime: p.endDateTime }];

  return { event: createEvents_(single).events[0] };
}

/* -------------------------------------------------------------------------- *
 * Cancelling sessions
 * -------------------------------------------------------------------------- */

/**
 * Mark one session and all of its bookings cancelled in the Sheet.
 *
 * Sheet-only on purpose: the caller holds the script lock across this, and the
 * slow outside-world work (Calendar, mail) happens afterwards in
 * finishCancellation_, so the lock is never held across a network call.
 *
 * @return {{eventRow: Object, students: Array<{email: string, name: string}>}}
 */
function prepareCancellation_(eventRow) {
  var bookings = confirmedBookingsForEvent_(trimStr_(eventRow.eventId));
  var students = bookings.map(function (row) {
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

  return { eventRow: eventRow, students: students };
}

/**
 * The outside-world half of a cancellation: delete the calendar event, which
 * makes Calendar notify every current guest (the instructor and every booked
 * student) in a single pass - that is why guests are not removed one by one
 * first - and then send our own mail on top.
 */
function finishCancellation_(pending, actorEmail) {
  var calendarUpdated = deleteCalendarEvent_(pending.eventRow.calendarEventId);
  var dto = toEventDto_(pending.eventRow, pending.students.length);
  sendEventCancelledEmails_(dto, pending.students, actorEmail);
  return { event: dto, students: pending.students, calendarUpdated: calendarUpdated };
}

/** Cancel a whole session (any teacher - shared-responsibility model). */
function cancelEvent_(params) {
  var user = requireTeacher_(params);
  requireParams_(params, ['eventId']);
  var eventId = trimStr_(params.eventId);

  var pending = null;

  var lock = LockService.getScriptLock();
  if (!lock.tryLock(LOCK_TIMEOUT_MS)) {
    fail_(ERR.BUSY, 'The booking system is busy right now. Please try again in a moment.');
  }

  try {
    var eventRow = findRecord_(SHEET_NAMES.EVENTS, function (row) {
      return trimStr_(row.eventId) === eventId;
    });
    if (!eventRow) {
      fail_(ERR.NOT_FOUND, 'That session could not be found.');
    }
    if (trimStr_(eventRow.status).toUpperCase() === EVENT_STATUS.CANCELLED) {
      fail_(ERR.EVENT_CANCELLED, 'That session is already cancelled.');
    }
    pending = prepareCancellation_(eventRow);
  } finally {
    lock.releaseLock();
  }

  var result = finishCancellation_(pending, user.email);

  return {
    eventId: eventId,
    notified: result.students.length,
    calendarUpdated: result.calendarUpdated
  };
}

/**
 * Cancel every session still standing in one bulk-published batch (any
 * teacher).
 *
 * Only upcoming, still-active members are touched: a batch that is half taught
 * should not have its history rewritten. Students get exactly the individual
 * per-session cancellation email they would get if each session were cancelled
 * by hand - nothing about the student side changes just because the sessions
 * happened to be created together.
 */
function cancelSeries_(params) {
  var user = requireTeacher_(params);
  requireParams_(params, ['seriesId']);
  var seriesId = trimStr_(params.seriesId);

  var pendings = [];
  var now = Date.now();

  var lock = LockService.getScriptLock();
  if (!lock.tryLock(LOCK_TIMEOUT_MS)) {
    fail_(ERR.BUSY, 'The booking system is busy right now. Please try again in a moment.');
  }

  try {
    var rows = readRecords_(SHEET_NAMES.EVENTS, function (row) {
      if (trimStr_(row.seriesId) !== seriesId) return false;
      if (trimStr_(row.status).toUpperCase() !== EVENT_STATUS.ACTIVE) return false;
      var start = toDate_(row.startDateTime);
      return !!(start && start.getTime() > now);
    });

    if (!rows.length) {
      fail_(ERR.NOT_FOUND,
        'No upcoming sessions are left in that batch - they have already been cancelled or taught.');
    }

    rows.sort(function (a, b) {
      return String(toIso_(a.startDateTime)).localeCompare(String(toIso_(b.startDateTime)));
    });
    rows.forEach(function (row) { pendings.push(prepareCancellation_(row)); });
  } finally {
    lock.releaseLock();
  }

  var notified = 0;
  var calendarUpdated = true;
  pendings.forEach(function (pending) {
    var result = finishCancellation_(pending, user.email);
    notified += result.students.length;
    if (!result.calendarUpdated) calendarUpdated = false;
  });

  return {
    seriesId: seriesId,
    cancelled: pendings.length,
    notified: notified,
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
