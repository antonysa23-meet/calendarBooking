/**
 * SheetService.js - generic row CRUD over the backing spreadsheet.
 *
 * Every tab is treated as a table whose first row is the header. Records are
 * plain objects keyed by header name, plus a non-enumerable-ish `_row` holding
 * the 1-based sheet row number so callers can update in place.
 */

function getSpreadsheet_() {
  var id = getProp_(PROP_KEYS.SPREADSHEET_ID);
  if (!id) {
    fail_(ERR.NOT_CONFIGURED,
      'SPREADSHEET_ID is not set. Run oneTimeSetup() from the Apps Script editor.');
  }
  try {
    return SpreadsheetApp.openById(id);
  } catch (e) {
    fail_(ERR.NOT_CONFIGURED, 'Cannot open the spreadsheet (' + id + '). Check SPREADSHEET_ID.');
  }
}

function getSheet_(tabName) {
  var sheet = getSpreadsheet_().getSheetByName(tabName);
  if (!sheet) {
    fail_(ERR.NOT_CONFIGURED,
      'Tab "' + tabName + '" is missing. Run oneTimeSetup() to create it.');
  }
  return sheet;
}

/** Header name -> 0-based column index, read fresh so column order can change. */
function getHeaderMap_(sheet) {
  var lastCol = sheet.getLastColumn();
  if (lastCol < 1) return {};
  var header = sheet.getRange(1, 1, 1, lastCol).getValues()[0];
  var map = {};
  for (var i = 0; i < header.length; i++) {
    var name = String(header[i]).trim();
    if (name) map[name] = i;
  }
  return map;
}

/**
 * Read every data row of a tab as an object.
 * @param {string} tabName
 * @param {function(Object):boolean=} predicate optional filter
 * @return {Array<Object>}
 */
function readRecords_(tabName, predicate) {
  var sheet = getSheet_(tabName);
  var lastRow = sheet.getLastRow();
  var lastCol = sheet.getLastColumn();
  if (lastRow < 2 || lastCol < 1) return [];

  var headerMap = getHeaderMap_(sheet);
  var names = Object.keys(headerMap);
  var values = sheet.getRange(2, 1, lastRow - 1, lastCol).getValues();
  var out = [];

  for (var r = 0; r < values.length; r++) {
    var row = values[r];
    // Skip fully blank rows left behind by manual edits.
    var blank = true;
    for (var c = 0; c < row.length; c++) {
      if (row[c] !== '' && row[c] !== null) { blank = false; break; }
    }
    if (blank) continue;

    var rec = { _row: r + 2 };
    for (var n = 0; n < names.length; n++) {
      rec[names[n]] = row[headerMap[names[n]]];
    }
    if (!predicate || predicate(rec)) out.push(rec);
  }
  return out;
}

/** First matching record, or null. */
function findRecord_(tabName, predicate) {
  var matches = readRecords_(tabName, predicate);
  return matches.length ? matches[0] : null;
}

/**
 * Append one record. Missing columns are written blank; unknown keys are
 * ignored so a caller can pass extra fields harmlessly.
 */
function appendRecord_(tabName, record) {
  var sheet = getSheet_(tabName);
  var headerMap = getHeaderMap_(sheet);
  var width = sheet.getLastColumn();
  var row = new Array(width).fill('');

  Object.keys(record).forEach(function (key) {
    if (key === '_row') return;
    var idx = headerMap[key];
    if (idx === undefined) return;
    var v = record[key];
    row[idx] = (v === null || v === undefined) ? '' : v;
  });

  sheet.appendRow(row);
  return sheet.getLastRow();
}

/**
 * Update named columns of an existing row.
 * @param {string} tabName
 * @param {number} rowNumber 1-based sheet row (from record._row)
 * @param {Object} updates column name -> new value
 */
function updateRecord_(tabName, rowNumber, updates) {
  var sheet = getSheet_(tabName);
  var headerMap = getHeaderMap_(sheet);
  Object.keys(updates).forEach(function (key) {
    var idx = headerMap[key];
    if (idx === undefined) return;
    var v = updates[key];
    sheet.getRange(rowNumber, idx + 1).setValue(v === null || v === undefined ? '' : v);
  });
}

/**
 * Apply the same updates to many rows in one read + one write.
 *
 * Cancelling a full session touches every booking row, and a setValue() per
 * cell is slow enough there to matter, so the whole span is rewritten at once.
 *
 * @param {string} tabName
 * @param {Array<number>} rowNumbers 1-based sheet rows
 * @param {Object} updates column name -> new value, applied to every row
 */
function bulkUpdateRecords_(tabName, rowNumbers, updates) {
  if (!rowNumbers || !rowNumbers.length) return;

  var sheet = getSheet_(tabName);
  var headerMap = getHeaderMap_(sheet);
  var columns = Object.keys(updates)
    .filter(function (key) { return headerMap[key] !== undefined; })
    .map(function (key) { return { index: headerMap[key], value: updates[key] }; });
  if (!columns.length) return;

  var min = Math.min.apply(null, rowNumbers);
  var max = Math.max.apply(null, rowNumbers);
  var width = sheet.getLastColumn();
  var range = sheet.getRange(min, 1, max - min + 1, width);
  var values = range.getValues();

  var wanted = {};
  rowNumbers.forEach(function (r) { wanted[r] = true; });

  for (var r = min; r <= max; r++) {
    if (!wanted[r]) continue;
    columns.forEach(function (col) {
      var v = col.value;
      values[r - min][col.index] = (v === null || v === undefined) ? '' : v;
    });
  }

  range.setValues(values);
}

/**
 * Ensure a tab exists with the expected header row, creating or repairing it.
 * Used by oneTimeSetup(); safe to re-run.
 */
function ensureTab_(spreadsheet, tabName, headers) {
  var sheet = spreadsheet.getSheetByName(tabName);
  if (!sheet) sheet = spreadsheet.insertSheet(tabName);

  var existing = sheet.getLastColumn() > 0
    ? sheet.getRange(1, 1, 1, sheet.getLastColumn()).getValues()[0].map(function (h) {
        return String(h).trim();
      })
    : [];

  // Add any header this build expects but the sheet does not have yet.
  var toAppend = headers.filter(function (h) { return existing.indexOf(h) === -1; });
  if (existing.length === 0) {
    sheet.getRange(1, 1, 1, headers.length).setValues([headers]);
  } else if (toAppend.length) {
    sheet.getRange(1, existing.length + 1, 1, toAppend.length).setValues([toAppend]);
  }

  var width = Math.max(headers.length, sheet.getLastColumn());
  sheet.getRange(1, 1, 1, width)
    .setFontWeight('bold')
    .setBackground('#00205B')
    .setFontColor('#FFFFFF');
  sheet.setFrozenRows(1);
  return sheet;
}
