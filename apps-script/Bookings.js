/**
 * Bookings.js - student-facing booking actions.
 *
 * Capacity is never cached on the Events row. It is recomputed from the
 * Bookings tab inside a script lock every time, so two students clicking Book
 * at the same instant cannot both take the last seat.
 */

/** eventId -> number of CONFIRMED bookings, from a single read of the tab. */
function confirmedCountsByEvent_() {
  var counts = {};
  readRecords_(SHEET_NAMES.BOOKINGS).forEach(function (row) {
    if (trimStr_(row.status).toUpperCase() !== BOOKING_STATUS.CONFIRMED) return;
    var id = trimStr_(row.eventId);
    counts[id] = (counts[id] || 0) + 1;
  });
  return counts;
}

/** Confirmed booking rows for one event. */
function confirmedBookingsForEvent_(eventId) {
  var target = trimStr_(eventId);
  return readRecords_(SHEET_NAMES.BOOKINGS, function (row) {
    return trimStr_(row.eventId) === target &&
           trimStr_(row.status).toUpperCase() === BOOKING_STATUS.CONFIRMED;
  });
}

/**
 * Book one seat.
 *
 * The read-check-append sequence runs under LockService.getScriptLock() so the
 * capacity cap and the duplicate check are atomic across concurrent requests.
 * Calendar and email work happens *after* the lock is released - both are slow
 * network calls and neither affects who got the seat.
 */
function bookSlot_(params) {
  requireParams_(params, ['eventId']);
  var user = requireUser_(params);
  var eventId = trimStr_(params.eventId);

  var eventRow = null;
  var booking = null;
  var seatsRemaining = 0;
  var capacity = 0;

  var lock = LockService.getScriptLock();
  if (!lock.tryLock(LOCK_TIMEOUT_MS)) {
    fail_(ERR.BUSY, 'The booking system is busy right now. Please try again in a moment.');
  }

  try {
    eventRow = findRecord_(SHEET_NAMES.EVENTS, function (row) {
      return trimStr_(row.eventId) === eventId;
    });
    if (!eventRow) {
      fail_(ERR.NOT_FOUND, 'That session no longer exists.');
    }
    if (trimStr_(eventRow.status).toUpperCase() !== EVENT_STATUS.ACTIVE) {
      fail_(ERR.EVENT_CANCELLED, 'That session has been cancelled.');
    }

    var start = toDate_(eventRow.startDateTime);
    if (!start || start.getTime() <= Date.now()) {
      fail_(ERR.EVENT_PAST, 'That session has already started. Bookings are closed.');
    }

    var existing = confirmedBookingsForEvent_(eventId);
    var already = existing.filter(function (row) {
      return normalizeEmail_(row.studentEmail) === user.email;
    });
    if (already.length) {
      fail_(ERR.ALREADY_BOOKED, 'You already have a seat in this session.');
    }

    capacity = asInt_(eventRow.capacity, 0);
    if (existing.length >= capacity) {
      fail_(ERR.EVENT_FULL, 'This session is full. All ' + capacity + ' seats are taken.');
    }

    booking = {
      bookingId: uuid_('bkg'),
      eventId: eventId,
      studentEmail: user.email,
      studentName: user.name,
      status: BOOKING_STATUS.CONFIRMED,
      bookedAt: nowIso_(),
      cancelledAt: ''
    };
    appendRecord_(SHEET_NAMES.BOOKINGS, booking);
    seatsRemaining = Math.max(0, capacity - (existing.length + 1));
  } finally {
    lock.releaseLock();
  }

  // --- Outside the lock: slow, best-effort side effects. -------------------
  var event = toEventDto_(eventRow, capacity - seatsRemaining);
  var calendarUpdated = addGuestToEvent_(eventRow.calendarEventId, user.email);
  if (!calendarUpdated) {
    console.warn('Booking ' + booking.bookingId + ' saved but the student was not added to ' +
      'calendar event ' + eventRow.calendarEventId + '.');
  }
  sendBookingConfirmation_(event, { email: user.email, name: user.name });

  return {
    bookingId: booking.bookingId,
    event: event,
    seatsRemaining: seatsRemaining,
    calendarUpdated: calendarUpdated
  };
}

/**
 * Cancel one of the caller's own bookings.
 *
 * Ownership is checked against the verified token, never against a
 * client-supplied email address.
 */
function cancelBooking_(params) {
  requireParams_(params, ['bookingId']);
  var user = requireUser_(params);
  var bookingId = trimStr_(params.bookingId);

  var bookingRow = null;
  var eventRow = null;
  var alreadyCancelled = false;
  var seatsRemaining = 0;
  var capacity = 0;

  var lock = LockService.getScriptLock();
  if (!lock.tryLock(LOCK_TIMEOUT_MS)) {
    fail_(ERR.BUSY, 'The booking system is busy right now. Please try again in a moment.');
  }

  try {
    bookingRow = findRecord_(SHEET_NAMES.BOOKINGS, function (row) {
      return trimStr_(row.bookingId) === bookingId;
    });
    if (!bookingRow) {
      fail_(ERR.NOT_FOUND, 'That booking could not be found.');
    }
    if (normalizeEmail_(bookingRow.studentEmail) !== user.email) {
      fail_(ERR.FORBIDDEN, 'You can only cancel your own bookings.');
    }

    alreadyCancelled =
      trimStr_(bookingRow.status).toUpperCase() === BOOKING_STATUS.CANCELLED;

    if (!alreadyCancelled) {
      updateRecord_(SHEET_NAMES.BOOKINGS, bookingRow._row, {
        status: BOOKING_STATUS.CANCELLED,
        cancelledAt: nowIso_()
      });
    }

    eventRow = findRecord_(SHEET_NAMES.EVENTS, function (row) {
      return trimStr_(row.eventId) === trimStr_(bookingRow.eventId);
    });
    if (eventRow) {
      capacity = asInt_(eventRow.capacity, 0);
      seatsRemaining = Math.max(0, capacity - confirmedBookingsForEvent_(eventRow.eventId).length);
    }
  } finally {
    lock.releaseLock();
  }

  if (alreadyCancelled) {
    return { bookingId: bookingId, alreadyCancelled: true, seatsRemaining: seatsRemaining };
  }

  var calendarUpdated = false;
  if (eventRow) {
    var event = toEventDto_(eventRow, capacity - seatsRemaining);
    calendarUpdated = removeGuestFromEvent_(eventRow.calendarEventId, user.email);
    sendBookingCancellation_(event, { email: user.email, name: user.name });
  }

  return {
    bookingId: bookingId,
    alreadyCancelled: false,
    seatsRemaining: seatsRemaining,
    calendarUpdated: calendarUpdated
  };
}

/**
 * The caller's own bookings, joined with their events and split into upcoming
 * and past. Cancelled bookings are omitted unless includeCancelled is set.
 */
function listMyBookings_(params) {
  var user = requireUser_(params);
  var includeCancelled = asBool_(params && params.includeCancelled);

  var mine = readRecords_(SHEET_NAMES.BOOKINGS, function (row) {
    if (normalizeEmail_(row.studentEmail) !== user.email) return false;
    if (includeCancelled) return true;
    return trimStr_(row.status).toUpperCase() === BOOKING_STATUS.CONFIRMED;
  });
  if (!mine.length) return { upcoming: [], past: [] };

  var eventsById = {};
  readRecords_(SHEET_NAMES.EVENTS).forEach(function (row) {
    eventsById[trimStr_(row.eventId)] = row;
  });
  var counts = confirmedCountsByEvent_();

  var now = Date.now();
  var upcoming = [];
  var past = [];

  mine.forEach(function (row) {
    var eventRow = eventsById[trimStr_(row.eventId)];
    if (!eventRow) return; // event row deleted by hand; nothing useful to show
    var item = {
      bookingId: trimStr_(row.bookingId),
      status: trimStr_(row.status).toUpperCase(),
      bookedAt: toIso_(row.bookedAt),
      cancelledAt: toIso_(row.cancelledAt),
      event: toEventDto_(eventRow, counts[trimStr_(eventRow.eventId)] || 0)
    };
    var start = toDate_(eventRow.startDateTime);
    if (start && start.getTime() >= now &&
        item.event.status === EVENT_STATUS.ACTIVE &&
        item.status === BOOKING_STATUS.CONFIRMED) {
      upcoming.push(item);
    } else {
      past.push(item);
    }
  });

  upcoming.sort(function (a, b) {
    return String(a.event.startDateTime).localeCompare(String(b.event.startDateTime));
  });
  past.sort(function (a, b) {
    return String(b.event.startDateTime).localeCompare(String(a.event.startDateTime));
  });

  return { upcoming: upcoming, past: past };
}
