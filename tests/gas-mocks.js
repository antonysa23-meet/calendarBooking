/**
 * gas-mocks.js - in-memory stand-ins for the Apps Script services.
 *
 * Enough of SpreadsheetApp / CalendarApp / MailApp / LockService / UrlFetchApp
 * to run the real backend files under Node, so the booking rules can be tested
 * without deploying. Not a general-purpose emulator - it implements exactly the
 * surface apps-script/ uses.
 *
 * ID tokens are faked: a token of the form "tok:email@rice.edu:Display Name"
 * comes back from the tokeninfo mock as that user.
 */

'use strict';

function createMocks(options = {}) {
  const sent = [];          // every email the code tried to send
  const calendarLog = [];   // every calendar mutation

  /* ---- Spreadsheet ----------------------------------------------------- */

  function makeSheet(name) {
    let data = [];   // array of row arrays
    let maxRows = options.sheetMaxRows === undefined ? 1000 : options.sheetMaxRows;

    const width = () => data.reduce((max, row) => Math.max(max, row.length), 0);

    const isBlank = (row) =>
      !row || row.every((cell) => cell === '' || cell === null || cell === undefined);

    const lastRow = () => {
      for (let i = data.length - 1; i >= 0; i--) if (!isBlank(data[i])) return i + 1;
      return 0;
    };

    function pad(row, size) {
      const out = row.slice();
      while (out.length < size) out.push('');
      return out;
    }

    function range(startRow, startCol, numRows, numCols) {
      if (startRow + numRows - 1 > maxRows) {
        throw new Error(
          `range (${startRow}:${startRow + numRows - 1}) exceeds the sheet's ${maxRows} rows`);
      }
      return {
        getValues() {
          const out = [];
          for (let r = 0; r < numRows; r++) {
            const source = data[startRow - 1 + r] || [];
            const row = [];
            for (let c = 0; c < numCols; c++) {
              const v = source[startCol - 1 + c];
              row.push(v === undefined ? '' : v);
            }
            out.push(row);
          }
          return out;
        },
        setValues(values) {
          values.forEach((row, r) => {
            const index = startRow - 1 + r;
            if (!data[index]) data[index] = [];
            row.forEach((v, c) => { data[index][startCol - 1 + c] = v; });
          });
          return this;
        },
        setValue(value) {
          const index = startRow - 1;
          if (!data[index]) data[index] = [];
          data[index][startCol - 1] = value;
          return this;
        },
        setFontWeight() { return this; },
        setBackground() { return this; },
        setFontColor() { return this; }
      };
    }

    return {
      _name: name,
      _dump: () => data.map((r) => r.slice()),
      getName: () => name,
      getLastRow: lastRow,
      getLastColumn: width,
      getRange: range,
      appendRow(row) {
        const target = Math.max(width(), row.length);
        const at = lastRow();
        data[at] = pad(row, target);
        // appendRow grows the sheet by itself in the real API; only getRange
        // refuses to address rows that do not exist yet.
        if (at + 1 > maxRows) maxRows = at + 1;
        return this;
      },
      // A real sheet has a fixed row count and getRange() throws past it, so
      // appendRecords_ has to grow the sheet first. Model that here or the
      // growth path never gets exercised.
      getMaxRows: () => maxRows,
      insertRowsAfter(afterRow, howMany) {
        if (afterRow !== maxRows) throw new Error('mock only grows from the end');
        maxRows += howMany;
        return this;
      },
      deleteRow(rowNumber) { data.splice(rowNumber - 1, 1); },
      setFrozenRows() { return this; }
    };
  }

  const sheets = new Map();

  const spreadsheet = {
    getId: () => 'ss_mock',
    getName: () => 'Proto Fab Cal - Booking Data (mock)',
    getUrl: () => 'https://docs.google.com/spreadsheets/d/ss_mock/edit',
    getSheetByName: (name) => sheets.get(name) || null,
    getSheets: () => [...sheets.values()],
    insertSheet(name) {
      const sheet = makeSheet(name);
      sheets.set(name, sheet);
      return sheet;
    },
    deleteSheet(sheet) { sheets.delete(sheet.getName()); }
  };

  const SpreadsheetApp = {
    openById: (id) => {
      if (options.brokenSpreadsheet) throw new Error('no such spreadsheet: ' + id);
      return spreadsheet;
    },
    create: () => spreadsheet
  };

  /* ---- Calendar -------------------------------------------------------- */

  const calendarEvents = new Map();
  let eventSeq = 0;

  function makeEvent(id, opts) {
    const guests = new Set((opts.guests || '').split(',').map((g) => g.trim()).filter(Boolean));
    return {
      _id: id,
      _deleted: false,
      _guests: guests,
      _title: opts.title,
      getId: () => id,
      getTitle: () => opts.title,
      addGuest(email) {
        if (options.calendarAddGuestFails) throw new Error('calendar unavailable');
        guests.add(email);
        calendarLog.push({ op: 'addGuest', id, email });
      },
      removeGuest(email) {
        guests.delete(email);
        calendarLog.push({ op: 'removeGuest', id, email });
      },
      deleteEvent() {
        calendarEvents.get(id)._deleted = true;
        calendarEvents.delete(id);
        calendarLog.push({ op: 'deleteEvent', id });
      },
      getGuestList: () => [...guests].map((email) => ({ getEmail: () => email })),
      setGuestsCanInviteOthers() {},
      setGuestsCanModify() {}
    };
  }

  const calendar = {
    getName: () => 'EDES 210 / BIOE 555 - Lab Sessions',
    getId: () => 'cal_mock@group.calendar.google.com',
    createEvent(title, start, end, opts = {}) {
      if (options.calendarCreateFails) throw new Error('calendar refused the event');
      // Fail the Nth create of the run, so a batch can break half-way.
      if (options.calendarCreateFailsAfter !== undefined &&
          eventSeq >= options.calendarCreateFailsAfter) {
        throw new Error('calendar refused the event');
      }
      const id = 'calevt_' + (++eventSeq);
      const event = makeEvent(id, Object.assign({ title }, opts));
      calendarEvents.set(id, event);
      calendarLog.push({ op: 'createEvent', id, title, guests: [...event._guests] });
      return event;
    },
    getEventById: (id) => calendarEvents.get(id) || null
  };

  const CalendarApp = {
    Color: { NAVY: 'NAVY' },
    getCalendarById: (id) => (id === 'cal_mock@group.calendar.google.com' ? calendar : null),
    getCalendarsByName: () => [calendar],
    createCalendar: () => calendar
  };

  /* ---- Mail ------------------------------------------------------------ */

  let quota = options.mailQuota === undefined ? 100 : options.mailQuota;

  const MailApp = {
    sendEmail(opts) {
      if (options.mailFails) throw new Error('mail service unavailable');
      if (quota <= 0) throw new Error('quota exceeded');
      quota -= 1;
      sent.push({ to: opts.to, subject: opts.subject, html: opts.htmlBody, name: opts.name });
    },
    getRemainingDailyQuota: () => quota
  };

  /* ---- Properties / cache / lock --------------------------------------- */

  const props = new Map(Object.entries(options.properties || {}));

  const PropertiesService = {
    getScriptProperties: () => ({
      getProperty: (key) => (props.has(key) ? props.get(key) : null),
      setProperty: (key, value) => { props.set(key, String(value)); }
    })
  };

  const cache = new Map();
  const CacheService = {
    getScriptCache: () => ({
      get: (key) => (cache.has(key) ? cache.get(key) : null),
      put: (key, value) => { cache.set(key, value); }
    })
  };

  let lockHeld = false;
  const LockService = {
    getScriptLock: () => ({
      tryLock: () => {
        if (options.lockUnavailable) return false;
        if (lockHeld) throw new Error('mock lock is not re-entrant - a nested tryLock is a bug');
        lockHeld = true;
        return true;
      },
      releaseLock: () => { lockHeld = false; }
    })
  };

  /* ---- UrlFetch (token verification) ----------------------------------- */

  const UrlFetchApp = {
    fetch(url) {
      const token = decodeURIComponent(String(url).split('id_token=')[1] || '');
      // Format: tok:<email>:<name>  - anything else is treated as invalid.
      const parts = token.split(':');
      if (parts[0] !== 'tok' || parts.length < 2) {
        return { getResponseCode: () => 400, getContentText: () => '{"error":"invalid_token"}' };
      }
      const payload = {
        aud: options.properties.OAUTH_CLIENT_ID,
        iss: 'https://accounts.google.com',
        exp: String(Math.floor(Date.now() / 1000) + 3600),
        email: parts[1],
        email_verified: 'true',
        name: parts[2] || parts[1],
        hd: parts[1].split('@')[1]
      };
      if (options.tokenAudienceMismatch) payload.aud = 'someone-elses-client-id';
      if (options.tokenExpired) payload.exp = String(Math.floor(Date.now() / 1000) - 60);
      return { getResponseCode: () => 200, getContentText: () => JSON.stringify(payload) };
    }
  };

  /* ---- Utilities / Session / ContentService ---------------------------- */

  let uuidSeq = 0;

  const Utilities = {
    getUuid: () => 'uuid-' + String(++uuidSeq).padStart(4, '0') + '-abcdef123456',
    computeDigest: (algo, value) => Array.from(String(value)).map((c) => c.charCodeAt(0)),
    base64EncodeWebSafe: (bytes) => Buffer.from(bytes).toString('base64url'),
    DigestAlgorithm: { SHA_256: 'SHA_256' },
    formatDate(date, tz, pattern) {
      const part = (opts) => new Intl.DateTimeFormat('en-US',
        Object.assign({ timeZone: tz }, opts)).format(date);
      if (pattern === 'EEEE, MMM d, yyyy') {
        return part({ weekday: 'long', month: 'short', day: 'numeric', year: 'numeric' })
          .replace(/,([^,]*)$/, ',$1');
      }
      if (pattern === 'yyyy-MM-dd') {
        return part({ year: 'numeric', month: '2-digit', day: '2-digit' })
          .replace(/^(\d+)\/(\d+)\/(\d+)$/, '$3-$1-$2');
      }
      if (pattern === 'h:mm a') return part({ hour: 'numeric', minute: '2-digit' });
      if (pattern === 'h:mm a z') {
        return part({ hour: 'numeric', minute: '2-digit', timeZoneName: 'short' });
      }
      return date.toISOString();
    }
  };

  const Session = {
    getScriptTimeZone: () => 'America/Chicago',
    getEffectiveUser: () => ({ getEmail: () => 'edes210andbioe555@gmail.com' })
  };

  const ContentService = {
    MimeType: { JSON: 'application/json' },
    createTextOutput: (text) => ({
      _text: text,
      setMimeType() { return this; },
      getContent: () => text
    })
  };

  return {
    SpreadsheetApp, CalendarApp, MailApp, PropertiesService, CacheService,
    LockService, UrlFetchApp, Utilities, Session, ContentService,
    console,
    // test-only handles
    _sent: sent,
    _calendarLog: calendarLog,
    _calendarEvents: calendarEvents,
    _sheets: sheets,
    _props: props,
    _quotaLeft: () => quota
  };
}

module.exports = { createMocks };
