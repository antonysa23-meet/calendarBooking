/* ==========================================================================
   config.js - the only file you need to edit after deploying.

   Fill in both values below. Neither is a secret: the Apps Script URL is a
   public endpoint that authorises every privileged call itself, and an OAuth
   Client ID is designed to ship in the page.
   ========================================================================== */

window.APP_CONFIG = {

  /**
   * The Apps Script Web App /exec URL.
   *
   * Apps Script editor -> Deploy -> New deployment -> Web app
   *   Execute as:      Me (edes210andbioe555@gmail.com)
   *   Who has access:  Anyone
   * Copy the URL it gives you. It must end in /exec - a /dev URL only works
   * while you are signed in as the owner and will fail for students.
   */
  APPS_SCRIPT_URL: 'https://script.google.com/macros/s/AKfycbyu5VpJExAo2nbYJaLkf0CbYfcSpD-ick3sRyVZcIDhOy7xEx2XfnbNi4T4axqF0kUJfw/exec',

  /**
   * OAuth 2.0 Web application Client ID from the Google Cloud project behind
   * the script. Authorised JavaScript origins must include the GitHub Pages
   * origin (e.g. https://edes210andbioe555.github.io) and, for local work,
   * http://localhost:8080.
   *
   * Leave this blank to have the page fetch it from the backend instead - one
   * fewer thing to keep in sync, at the cost of one extra request before the
   * sign-in button appears.
   */
  GOOGLE_CLIENT_ID: '648143527214-494u5qjo18hd47dqp9588fi2i9dstjs1.apps.googleusercontent.com',

  /**
   * Restricts the Google account chooser to this domain. The server enforces
   * the same rule regardless; this only saves students from picking the wrong
   * account. Set to '' to allow any account through the picker.
   */
  HOSTED_DOMAIN: 'rice.edu',

  /** All session times are shown in this zone, whatever the visitor's clock. */
  DISPLAY_TIMEZONE: 'America/Chicago',

  /** Shown when a session has this many seats left or fewer. */
  LOW_SEATS_THRESHOLD: 3
};
