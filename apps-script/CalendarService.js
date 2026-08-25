/**
 * CalendarService.js - CalendarApp wrappers for the dedicated booking calendar.
 *
 * Guest changes here are what trigger Google Calendar's own invitation and
 * cancellation emails; the custom Rice-branded mail in EmailService is on top
 * of that, not instead of it.
 *
 * The Sheet is the source of truth. Calendar failures on secondary operations
 * (add/remove guest) are logged and reported to the caller rather than thrown,
 * so a booking is never lost because Calendar hiccuped.
 */

function getBookingCalendar_() {
  var id = getProp_(PROP_KEYS.CALENDAR_ID);
  if (!id) {
    fail_(ERR.NOT_CONFIGURED,
      'CALENDAR_ID is not set. Run oneTimeSetup() from the Apps Script editor.');
  }
  var cal = CalendarApp.getCalendarById(id);
  if (!cal) {
    fail_(ERR.NOT_CONFIGURED,
      'Calendar ' + id + ' is not accessible from this account. Check CALENDAR_ID.');
  }
  return cal;
}

/**
 * Create the session event on the booking calendar with the teacher invited.
 * @return {string} the Calendar event id, stored on the Events row.
 */
function createCalendarEvent_(opts) {
  var cal = getBookingCalendar_();
  var event = cal.createEvent(
    opts.title,
    new Date(opts.startIso),
    new Date(opts.endIso),
    {
      description: opts.description || '',
      location: opts.location || '',
      guests: (opts.guests || []).join(','),
      sendInvites: true
    }
  );
  // Students should not be able to invite others or see each other's addresses
  // beyond what Calendar shows guests by default.
  try {
    event.setGuestsCanInviteOthers(false);
    event.setGuestsCanModify(false);
  } catch (e) {
    console.warn('Could not tighten guest permissions: ' + e);
  }
  return event.getId();
}

/** Fetch an event by id, or null if it is gone. */
function getCalendarEvent_(calendarEventId) {
  if (!calendarEventId) return null;
  try {
    return getBookingCalendar_().getEventById(calendarEventId);
  } catch (e) {
    console.warn('getEventById failed for ' + calendarEventId + ': ' + e);
    return null;
  }
}

/**
 * Add a guest. Calendar emails them the invitation.
 * @return {boolean} whether Calendar was actually updated.
 */
function addGuestToEvent_(calendarEventId, email) {
  var event = getCalendarEvent_(calendarEventId);
  if (!event) {
    console.warn('addGuest: calendar event ' + calendarEventId + ' not found.');
    return false;
  }
  try {
    event.addGuest(email);
    return true;
  } catch (e) {
    console.error('addGuest failed for ' + email + ' on ' + calendarEventId + ': ' + e);
    return false;
  }
}

/**
 * Remove a guest. Calendar emails them the cancellation.
 * @return {boolean} whether Calendar was actually updated.
 */
function removeGuestFromEvent_(calendarEventId, email) {
  var event = getCalendarEvent_(calendarEventId);
  if (!event) {
    console.warn('removeGuest: calendar event ' + calendarEventId + ' not found.');
    return false;
  }
  try {
    event.removeGuest(email);
    return true;
  } catch (e) {
    console.error('removeGuest failed for ' + email + ' on ' + calendarEventId + ': ' + e);
    return false;
  }
}

/**
 * Delete the event. Calendar notifies every current guest (teacher and all
 * booked students) in one shot, which is why cancelEvent does not remove
 * guests individually first.
 * @return {boolean} whether Calendar was actually updated.
 */
function deleteCalendarEvent_(calendarEventId) {
  var event = getCalendarEvent_(calendarEventId);
  if (!event) {
    console.warn('deleteEvent: calendar event ' + calendarEventId + ' not found.');
    return false;
  }
  try {
    event.deleteEvent();
    return true;
  } catch (e) {
    console.error('deleteEvent failed for ' + calendarEventId + ': ' + e);
    return false;
  }
}

/** Guest email addresses currently on the event, for reconciliation checks. */
function listEventGuestEmails_(calendarEventId) {
  var event = getCalendarEvent_(calendarEventId);
  if (!event) return [];
  try {
    return event.getGuestList().map(function (g) { return normalizeEmail_(g.getEmail()); });
  } catch (e) {
    console.warn('getGuestList failed for ' + calendarEventId + ': ' + e);
    return [];
  }
}
