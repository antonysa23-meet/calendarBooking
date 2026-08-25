/**
 * Code.js - Web App entry points and the action router.
 *
 * One deployment URL serves everything, split by sensitivity:
 *
 *   doGet  - public reads only, no identity: listEvents, listCourses, config.
 *   doPost - anything carrying an identity token or mutating state.
 *
 * The POST body is a JSON *string* sent as text/plain. That is deliberate:
 * an application/json body makes the browser send a CORS preflight, which
 * Apps Script Web Apps do not answer. text/plain is a "simple request", so the
 * browser skips the preflight entirely. The ID token therefore travels in the
 * body - never in a header or a query string, where it would end up in logs.
 *
 * Every response is HTTP 200 with an envelope: {success, data|error, message}.
 * Apps Script cannot set status codes, so clients must branch on `success`.
 */

function doGet(e) {
  try {
    var params = (e && e.parameter) || {};
    var action = trimStr_(params.action) || 'ping';

    switch (action) {
      case 'ping':
        return jsonOutput_(ok_({ service: 'proto-fab-cal', time: nowIso_() }));

      case 'config':
        return jsonOutput_(ok_(publicConfig_()));

      case 'listCourses':
        return jsonOutput_(ok_(listCourses_()));

      case 'listEvents':
        return jsonOutput_(ok_(listEvents_(params)));

      default:
        return jsonOutput_(err_(ERR.UNKNOWN_ACTION,
          'Unknown action "' + action + '". This endpoint accepts GET for ' +
          'ping, config, listCourses and listEvents only.'));
    }
  } catch (ex) {
    return jsonOutput_(toErrorEnvelope_(ex));
  }
}

function doPost(e) {
  try {
    var body = parsePostBody_(e);
    var action = trimStr_(body.action);
    if (!action) {
      return jsonOutput_(err_(ERR.BAD_REQUEST, 'No action was specified.'));
    }

    switch (action) {
      // --- identity -------------------------------------------------------
      case 'whoAmI':
        return jsonOutput_(ok_(whoAmI_(body)));

      // --- student --------------------------------------------------------
      case 'bookSlot':
        return jsonOutput_(ok_(bookSlot_(body), 'Your seat is confirmed.'));

      case 'cancelBooking':
        return jsonOutput_(ok_(cancelBooking_(body), 'Your booking has been cancelled.'));

      case 'listMyBookings':
        return jsonOutput_(ok_(listMyBookings_(body)));

      // --- teacher --------------------------------------------------------
      case 'createEvent':
        return jsonOutput_(ok_(createEvent_(body), 'Session published.'));

      case 'createEvents':
        return jsonOutput_(ok_(createEvents_(body), 'Sessions published.'));

      case 'cancelEvent':
        return jsonOutput_(ok_(cancelEvent_(body), 'Session cancelled and everyone notified.'));

      case 'cancelSeries':
        return jsonOutput_(ok_(cancelSeries_(body), 'Batch cancelled and everyone notified.'));

      case 'getRoster':
        return jsonOutput_(ok_(getRoster_(body)));

      case 'listTeachers':
        return jsonOutput_(ok_(listTeachers_(body)));

      // --- public reads, also allowed over POST for convenience -----------
      case 'listEvents':
        return jsonOutput_(ok_(listEvents_(body)));

      case 'listCourses':
        return jsonOutput_(ok_(listCourses_()));

      default:
        return jsonOutput_(err_(ERR.UNKNOWN_ACTION, 'Unknown action "' + action + '".'));
    }
  } catch (ex) {
    return jsonOutput_(toErrorEnvelope_(ex));
  }
}

/**
 * Read the request body. Accepts a raw JSON string (the normal path) and also
 * form-encoded parameters, which makes the endpoint easy to poke at with curl.
 */
function parsePostBody_(e) {
  if (!e) return {};

  if (e.postData && e.postData.contents) {
    var raw = String(e.postData.contents).trim();
    if (raw.charAt(0) === '{') {
      try {
        return JSON.parse(raw);
      } catch (err) {
        fail_(ERR.BAD_REQUEST, 'The request body was not valid JSON.');
      }
    }
  }

  // Fall back to query/form parameters.
  var params = {};
  Object.keys(e.parameter || {}).forEach(function (key) {
    params[key] = e.parameter[key];
  });
  return params;
}

/**
 * Non-secret settings the frontend can fetch instead of hard-coding. The OAuth
 * Client ID is public by design (it ships in the page anyway); this just keeps
 * it configured in one place.
 */
function publicConfig_() {
  return {
    googleClientId: getProp_(PROP_KEYS.OAUTH_CLIENT_ID),
    allowedDomain: ALLOWED_EMAIL_DOMAIN,
    timeZone: scriptTimeZone_(),
    sessionTypes: SESSION_TYPES,
    siteUrl: getProp_(PROP_KEYS.SITE_URL)
  };
}
