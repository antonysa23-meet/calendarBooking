/**
 * Auth.js - identity verification and role gating. The whole security model
 * lives in this file.
 *
 * Important: Session.getActiveUser() does NOT identify the site visitor. This
 * Web App is deployed "Execute as: Me / Who has access: Anyone", so every
 * request runs as the shared account regardless of who is browsing. Caller
 * identity comes exclusively from the Google ID token in the POST body, which
 * we verify against Google before trusting a single field of it.
 */

/**
 * Verify a Google Identity Services ID token and return the caller.
 *
 * Checks, in order: signature/validity (via Google's tokeninfo endpoint),
 * audience matches our OAuth Client ID, issuer is Google, not expired, email
 * verified, and the address is in the allowed domain.
 *
 * @param {string} idToken
 * @return {{email:string, name:string, picture:string, hd:string}}
 */
function verifyIdToken_(idToken) {
  var token = trimStr_(idToken);
  if (!token) {
    fail_(ERR.UNAUTHENTICATED, 'Please sign in with your Rice account to continue.');
  }

  var clientId = getProp_(PROP_KEYS.OAUTH_CLIENT_ID);
  if (!clientId) {
    fail_(ERR.NOT_CONFIGURED,
      'OAUTH_CLIENT_ID is not set. Run setOAuthClientId("...") in the Apps Script editor.');
  }

  var cache = CacheService.getScriptCache();
  var cacheKey = 'idtok_' + Utilities.base64EncodeWebSafe(
    Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, token)
  );

  var cached = cache.get(cacheKey);
  if (cached) {
    try {
      return JSON.parse(cached);
    } catch (e) {
      // fall through and re-verify
    }
  }

  var response;
  try {
    response = UrlFetchApp.fetch(
      'https://oauth2.googleapis.com/tokeninfo?id_token=' + encodeURIComponent(token),
      { muteHttpExceptions: true }
    );
  } catch (e) {
    console.error('tokeninfo request failed: ' + e);
    fail_(ERR.INTERNAL, 'Could not reach Google to verify your sign-in. Please try again.');
  }

  if (response.getResponseCode() !== 200) {
    fail_(ERR.UNAUTHENTICATED, 'Your sign-in has expired. Please sign in again.');
  }

  var info;
  try {
    info = JSON.parse(response.getContentText());
  } catch (e) {
    fail_(ERR.UNAUTHENTICATED, 'Your sign-in could not be verified. Please sign in again.');
  }

  // The token must have been minted for *this* application.
  if (info.aud !== clientId) {
    console.warn('Token audience mismatch. Got: ' + info.aud);
    fail_(ERR.UNAUTHENTICATED, 'This sign-in was not issued for this site. Please sign in again.');
  }

  if (info.iss !== 'accounts.google.com' && info.iss !== 'https://accounts.google.com') {
    fail_(ERR.UNAUTHENTICATED, 'Unrecognised sign-in issuer. Please sign in again.');
  }

  var expMs = asInt_(info.exp, 0) * 1000;
  if (!expMs || expMs <= Date.now()) {
    fail_(ERR.UNAUTHENTICATED, 'Your sign-in has expired. Please sign in again.');
  }

  if (String(info.email_verified) !== 'true') {
    fail_(ERR.UNAUTHENTICATED, 'This Google account has no verified email address.');
  }

  var email = normalizeEmail_(info.email);
  if (!email || !isAllowedDomain_(email)) {
    fail_(ERR.FORBIDDEN_DOMAIN,
      'Only @' + ALLOWED_EMAIL_DOMAIN + ' accounts can use this site. You signed in as ' +
      (email || 'an unknown account') + '.');
  }

  var user = {
    email: email,
    name: trimStr_(info.name, 120) || email,
    picture: trimStr_(info.picture, 400),
    hd: normalizeEmail_(info.hd)
  };

  // Cache briefly so a page that makes several calls verifies once. Never cache
  // past the token's own expiry.
  var ttl = Math.max(0, Math.min(300, Math.floor((expMs - Date.now()) / 1000) - 30));
  if (ttl > 0) cache.put(cacheKey, JSON.stringify(user), ttl);

  return user;
}

/**
 * The email address must be in the allowed domain. The `hd` claim is treated as
 * a secondary signal only - a Workspace account can lack it, and a consumer
 * account can never fake the verified address itself.
 */
function isAllowedDomain_(email) {
  return normalizeEmail_(email).slice(-(ALLOWED_EMAIL_DOMAIN.length + 1)) === '@' + ALLOWED_EMAIL_DOMAIN;
}

/**
 * Is this address on the Teachers allow-list and still active?
 * The Sheet is the authority, so teachers can be added/removed without a deploy.
 */
function isTeacher_(email) {
  var target = normalizeEmail_(email);
  if (!target) return false;
  var match = findRecord_(SHEET_NAMES.TEACHERS, function (row) {
    return normalizeEmail_(row.email) === target && asBool_(row.active);
  });
  return !!match;
}

/**
 * Verify the token and attach the teacher flag. This is the single entry point
 * every privileged action goes through.
 *
 * @param {Object} params the parsed POST body
 * @return {{email:string, name:string, picture:string, isTeacher:boolean}}
 */
function requireUser_(params) {
  var user = verifyIdToken_(params && params.idToken);
  user.isTeacher = isTeacher_(user.email);
  return user;
}

/** Same as requireUser_, but rejects anyone not on the Teachers allow-list. */
function requireTeacher_(params) {
  var user = requireUser_(params);
  if (!user.isTeacher) {
    fail_(ERR.FORBIDDEN,
      'This action is limited to course instructors. If you should have access, ask for your ' +
      'address to be added to the Teachers list.');
  }
  return user;
}

/**
 * The active allow-list, so the admin form can offer "assign this session to
 * another instructor". Teacher-only: it is a staff directory, not public data.
 */
function listTeachers_(params) {
  requireTeacher_(params);
  var rows = readRecords_(SHEET_NAMES.TEACHERS, function (row) {
    return asBool_(row.active) && isAllowedDomain_(row.email);
  });
  return {
    teachers: rows.map(function (row) {
      return {
        email: normalizeEmail_(row.email),
        name: trimStr_(row.name) || normalizeEmail_(row.email)
      };
    }).sort(function (a, b) { return a.name.localeCompare(b.name); })
  };
}

/**
 * whoAmI - lets the frontend learn its own role after sign-in so it can show or
 * hide the Admin tab. The client-side check is UX only; every privileged action
 * re-verifies server-side.
 */
function whoAmI_(params) {
  var user = requireUser_(params);
  return {
    email: user.email,
    name: user.name,
    picture: user.picture,
    isTeacher: user.isTeacher
  };
}
