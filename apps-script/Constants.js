/**
 * Constants.js
 *
 * Shared names, enums and Script Property keys.
 *
 * Apps Script concatenates every .js file in the project and the load order is
 * not guaranteed, so nothing here may reference a value defined in another
 * file at the top level. Plain literals only.
 */

/** Tab names inside the backing Google Sheet. */
var SHEET_NAMES = {
  EVENTS: 'Events',
  BOOKINGS: 'Bookings',
  TEACHERS: 'Teachers',
  COURSES: 'Courses'
};

/**
 * Header row for each tab. The header row is the schema: SheetService maps
 * column name to index at read time, so columns can be reordered in the Sheet
 * without breaking the code (but they must not be renamed).
 */
var SHEET_HEADERS = {
  Events: [
    'eventId', 'seriesId', 'courseId', 'title', 'sessionType', 'description',
    'startDateTime', 'endDateTime', 'location', 'capacity',
    'teacherEmail', 'teacherName', 'calendarEventId', 'status',
    'createdBy', 'createdAt'
  ],
  Bookings: [
    'bookingId', 'eventId', 'studentEmail', 'studentName',
    'status', 'bookedAt', 'cancelledAt'
  ],
  Teachers: ['email', 'name', 'active', 'addedAt'],
  Courses: ['courseId', 'courseName', 'active']
};

var EVENT_STATUS = { ACTIVE: 'ACTIVE', CANCELLED: 'CANCELLED' };
var BOOKING_STATUS = { CONFIRMED: 'CONFIRMED', CANCELLED: 'CANCELLED' };

/** Keys in PropertiesService.getScriptProperties(). */
var PROP_KEYS = {
  SPREADSHEET_ID: 'SPREADSHEET_ID',
  CALENDAR_ID: 'CALENDAR_ID',
  OAUTH_CLIENT_ID: 'OAUTH_CLIENT_ID',
  FROM_NAME: 'FROM_NAME',
  SITE_URL: 'SITE_URL'
};

/** Only accounts in this domain may sign in. Enforced server-side. */
var ALLOWED_EMAIL_DOMAIN = 'rice.edu';

/** Display name of the dedicated secondary calendar created by oneTimeSetup(). */
var CALENDAR_NAME = 'EDES 210 / BIOE 555 - Lab Sessions';

var DEFAULT_FROM_NAME = 'OEDK Lab Sessions';

/**
 * Offered in the admin create-event form's dropdown.
 *
 * The server does not validate against this list - it is a convenience, and
 * any free text a teacher types is accepted. So adding, renaming or reordering
 * entries here never invalidates sessions that already exist.
 *
 * Grouped by process: subtractive/cutting first, then additive, then the rest.
 */
var SESSION_TYPES = [
  'Safety Training',
  'Equipment Orientation',
  'Laser Cutting',
  'Water Jet Cutting',
  'Plasma Cutting',
  'CNC Machining',
  '3D Printing',
  'Molding and Casting',
  'Electronics',
  'Open Lab',
  'Other'
];

/** Machine-readable error codes the frontend branches on. */
var ERR = {
  NOT_CONFIGURED: 'NOT_CONFIGURED',
  BAD_REQUEST: 'BAD_REQUEST',
  UNKNOWN_ACTION: 'UNKNOWN_ACTION',
  UNAUTHENTICATED: 'UNAUTHENTICATED',
  FORBIDDEN_DOMAIN: 'FORBIDDEN_DOMAIN',
  FORBIDDEN: 'FORBIDDEN',
  NOT_FOUND: 'NOT_FOUND',
  EVENT_FULL: 'EVENT_FULL',
  ALREADY_BOOKED: 'ALREADY_BOOKED',
  EVENT_CANCELLED: 'EVENT_CANCELLED',
  EVENT_PAST: 'EVENT_PAST',
  CANCEL_CLOSED: 'CANCEL_CLOSED',
  BUSY: 'BUSY',
  INTERNAL: 'INTERNAL'
};

/** How long bookSlot waits for the script lock before giving up. */
var LOCK_TIMEOUT_MS = 20000;

/** Hard ceiling on capacity, to catch typos like 1000 in the admin form. */
var MAX_CAPACITY = 500;

/**
 * Hard ceiling on how many sessions one bulk request may publish.
 *
 * Each session costs a CalendarApp.createEvent round-trip (roughly a second),
 * and the whole request has to finish inside the Apps Script runtime limit. 40
 * keeps the worst case well under it; a bigger schedule is published in two
 * passes, which is also easier to sanity-check before hitting publish.
 */
var MAX_BULK_SESSIONS = 40;
