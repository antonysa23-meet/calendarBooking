/**
 * Utils.js - response envelopes, errors, ids and date/string helpers.
 */

/**
 * Wrap a payload for the Web App. Apps Script cannot return custom HTTP status
 * codes, so every response is 200 and the client branches on `success`.
 */
function jsonOutput_(envelope) {
  return ContentService
    .createTextOutput(JSON.stringify(envelope))
    .setMimeType(ContentService.MimeType.JSON);
}

function ok_(data, message) {
  return {
    success: true,
    data: (data === undefined ? null : data),
    message: message || ''
  };
}

function err_(code, message) {
  return { success: false, error: code, message: message || 'Something went wrong.' };
}

/**
 * Throw an error the router turns into a clean {success:false} envelope with a
 * machine-readable code, instead of leaking a stack trace to the browser.
 */
function fail_(code, message) {
  var e = new Error(message);
  e.appErrorCode = code;
  throw e;
}

/** Convert any thrown value into an error envelope. */
function toErrorEnvelope_(ex) {
  if (ex && ex.appErrorCode) {
    return err_(ex.appErrorCode, ex.message);
  }
  console.error('Unhandled error: ' + (ex && ex.stack ? ex.stack : ex));
  return err_(ERR.INTERNAL, 'Unexpected server error. Please try again.');
}

function uuid_(prefix) {
  var raw = Utilities.getUuid().replace(/-/g, '').slice(0, 12);
  return (prefix ? prefix + '_' : '') + raw;
}

function nowIso_() {
  return new Date().toISOString();
}

/**
 * Sheets sometimes coerces an ISO string cell into a real Date. Accept either
 * and always hand back an ISO string (or empty string when blank).
 */
function toIso_(value) {
  if (value === null || value === undefined || value === '') return '';
  if (Object.prototype.toString.call(value) === '[object Date]') {
    return isNaN(value.getTime()) ? '' : value.toISOString();
  }
  var d = new Date(value);
  return isNaN(d.getTime()) ? String(value) : d.toISOString();
}

function toDate_(value) {
  var iso = toIso_(value);
  if (!iso) return null;
  var d = new Date(iso);
  return isNaN(d.getTime()) ? null : d;
}

function scriptTimeZone_() {
  return Session.getScriptTimeZone() || 'America/Chicago';
}

/** The calendar day a moment falls on in the lab's timezone, as "yyyy-MM-dd". */
function dayKey_(value) {
  var d = toDate_(value);
  return d ? Utilities.formatDate(d, scriptTimeZone_(), 'yyyy-MM-dd') : '';
}

/**
 * Students may not release a seat on the day the session runs - by then the
 * instructor is counting on the head count and a freed seat is too late for
 * anyone else to take. The cutoff is midnight in the lab's timezone, not a
 * rolling 24 hours, so "not today" means the same thing to everyone.
 */
function cancellationClosed_(startValue) {
  var sessionDay = dayKey_(startValue);
  if (!sessionDay) return false;
  return sessionDay <= dayKey_(new Date());
}

/** e.g. "Monday, Sep 14, 2026, 2:00 PM - 3:30 PM CDT" */
function formatRange_(startValue, endValue) {
  var tz = scriptTimeZone_();
  var start = toDate_(startValue);
  var end = toDate_(endValue);
  if (!start) return '';
  var day = Utilities.formatDate(start, tz, 'EEEE, MMM d, yyyy');
  var from = Utilities.formatDate(start, tz, 'h:mm a');
  if (!end) return day + ', ' + from;
  var to = Utilities.formatDate(end, tz, 'h:mm a z');
  return day + ', ' + from + ' - ' + to;
}

function escapeHtml_(value) {
  return String(value === null || value === undefined ? '' : value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function normalizeEmail_(value) {
  return String(value === null || value === undefined ? '' : value).trim().toLowerCase();
}

function asBool_(value) {
  if (value === true) return true;
  if (value === false || value === null || value === undefined || value === '') return false;
  var s = String(value).trim().toLowerCase();
  return s === 'true' || s === 'yes' || s === 'y' || s === '1' || s === 'active';
}

function asInt_(value, fallback) {
  var n = parseInt(value, 10);
  return isNaN(n) ? fallback : n;
}

function trimStr_(value, maxLength) {
  var s = String(value === null || value === undefined ? '' : value).trim();
  return (maxLength && s.length > maxLength) ? s.slice(0, maxLength) : s;
}

/** Throw BAD_REQUEST unless every named param is present and non-empty. */
function requireParams_(params, names) {
  var missing = [];
  for (var i = 0; i < names.length; i++) {
    var v = params ? params[names[i]] : null;
    if (v === null || v === undefined || String(v).trim() === '') missing.push(names[i]);
  }
  if (missing.length) {
    fail_(ERR.BAD_REQUEST, 'Missing required field(s): ' + missing.join(', ') + '.');
  }
}

function getProp_(key) {
  return PropertiesService.getScriptProperties().getProperty(key) || '';
}

function setProp_(key, value) {
  PropertiesService.getScriptProperties().setProperty(key, String(value));
}
