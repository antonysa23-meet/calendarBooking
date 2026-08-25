/* ==========================================================================
   api.js - the fetch wrapper every other script depends on.

   Two things here are load-bearing and easy to break:

   1. POSTs send Content-Type: text/plain;charset=utf-8 with a JSON *string* as
      the body. An application/json body would make the browser fire a CORS
      preflight (OPTIONS), and Apps Script Web Apps do not answer preflights -
      the request fails before it ever reaches the script. text/plain qualifies
      as a "simple request", so the browser skips the preflight.

   2. Apps Script cannot return HTTP status codes, so every response is 200 and
      carries an envelope: {success, data|error, message}. Never branch on
      res.ok - branch on the envelope.
   ========================================================================== */

/** Error carrying the backend's machine-readable code (see ERR in Constants.js). */
class ApiError extends Error {
  constructor(code, message) {
    super(message || 'Something went wrong.');
    this.name = 'ApiError';
    this.code = code || 'UNKNOWN';
  }
}

const Api = (function () {
  const PLACEHOLDER = 'PASTE_YOUR_APPS_SCRIPT_EXEC_URL_HERE';

  function baseUrl() {
    const url = (window.APP_CONFIG && window.APP_CONFIG.APPS_SCRIPT_URL || '').trim();
    if (!url || url === PLACEHOLDER) {
      throw new ApiError(
        'NOT_CONFIGURED',
        'This site is not connected to its backend yet. Set APPS_SCRIPT_URL in js/config.js.'
      );
    }
    return url;
  }

  /** Parse the envelope and turn a failure into a typed ApiError. */
  async function unwrap(response) {
    const text = await response.text();
    let envelope;

    try {
      envelope = JSON.parse(text);
    } catch (e) {
      // Almost always the sign-in interstitial: the deployment is set to
      // "Who has access: Only myself" instead of "Anyone".
      if (/<html/i.test(text)) {
        throw new ApiError(
          'NOT_CONFIGURED',
          'The backend returned a sign-in page instead of data. Re-deploy the Web App with ' +
          '"Who has access: Anyone".'
        );
      }
      throw new ApiError('BAD_RESPONSE', 'The server sent a response the page could not read.');
    }

    if (!envelope || envelope.success !== true) {
      throw new ApiError(
        (envelope && envelope.error) || 'UNKNOWN',
        (envelope && envelope.message) || 'The request failed.'
      );
    }
    return envelope.data;
  }

  function networkError(e) {
    if (e instanceof ApiError) return e;
    return new ApiError(
      'NETWORK',
      'Could not reach the booking service. Check your connection and try again.'
    );
  }

  /** Public read. No identity is sent. */
  async function get(action, params) {
    const url = new URL(baseUrl());
    url.searchParams.set('action', action);
    Object.entries(params || {}).forEach(([key, value]) => {
      if (value !== undefined && value !== null && value !== '') {
        url.searchParams.set(key, String(value));
      }
    });

    try {
      const response = await fetch(url.toString(), {
        method: 'GET',
        redirect: 'follow'
      });
      return await unwrap(response);
    } catch (e) {
      throw networkError(e);
    }
  }

  /** Raw POST. Use postAuthed for anything that needs an identity. */
  async function post(action, payload) {
    const body = JSON.stringify(Object.assign({ action }, payload || {}));

    try {
      const response = await fetch(baseUrl(), {
        method: 'POST',
        // Deliberately text/plain - see the note at the top of this file.
        headers: { 'Content-Type': 'text/plain;charset=utf-8' },
        body,
        redirect: 'follow'
      });
      return await unwrap(response);
    } catch (e) {
      throw networkError(e);
    }
  }

  /**
   * POST with the signed-in user's ID token attached. The token goes in the
   * body, never in a header or the query string, where it would be logged.
   */
  async function postAuthed(action, payload) {
    const token = window.Auth ? window.Auth.getToken() : null;
    if (!token) {
      throw new ApiError('UNAUTHENTICATED', 'Please sign in with your Rice account to continue.');
    }

    try {
      return await post(action, Object.assign({ idToken: token }, payload || {}));
    } catch (e) {
      // A rejected token is almost always an expired one; drop it so the UI
      // falls back to the signed-out state instead of looping on failures.
      if (e instanceof ApiError && e.code === 'UNAUTHENTICATED' && window.Auth) {
        window.Auth.clearToken();
      }
      throw e;
    }
  }

  return {
    get,
    post,
    postAuthed,

    /* ---- Named endpoints -------------------------------------------- */
    ping: () => get('ping'),
    getConfig: () => get('config'),
    listCourses: () => get('listCourses'),
    listEvents: (filters) => get('listEvents', filters),

    whoAmI: () => postAuthed('whoAmI'),
    bookSlot: (eventId) => postAuthed('bookSlot', { eventId }),
    cancelBooking: (bookingId) => postAuthed('cancelBooking', { bookingId }),
    listMyBookings: (opts) => postAuthed('listMyBookings', opts),

    createEvent: (event) => postAuthed('createEvent', event),
    createEvents: (batch) => postAuthed('createEvents', batch),
    cancelEvent: (eventId) => postAuthed('cancelEvent', { eventId }),
    cancelSeries: (seriesId) => postAuthed('cancelSeries', { seriesId }),
    getRoster: (eventId) => postAuthed('getRoster', { eventId }),
    listTeachers: () => postAuthed('listTeachers')
  };
})();

window.Api = Api;
window.ApiError = ApiError;
