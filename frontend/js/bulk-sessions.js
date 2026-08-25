/* ==========================================================================
   bulk-sessions.js - the two pieces the admin panel needs to publish a whole
   schedule at once: a multi-date month picker, and the slot planner that turns
   "these dates, 5-7pm, 30 minutes each" into a concrete list of sessions.

   planSlots() is deliberately pure and works in wall-clock strings only - no
   Date objects, no timezone, no DOM. Converting a wall-clock slot to a real
   instant is the caller's job (admin.js hands it UI.localInputToIso, which is
   the same DST-correct conversion the single-session form uses). Keeping the
   arithmetic separate from the conversion is what makes it testable in node.
   ========================================================================== */

const BulkSessions = (function () {

  /* ---- Slot planning (pure) -------------------------------------------- */

  const MIN_SLOT_MINUTES = 5;

  /** "17:30" -> 1050. Returns null on anything unparseable. */
  function parseTime(value) {
    const match = /^(\d{1,2}):(\d{2})$/.exec(String(value || '').trim());
    if (!match) return null;
    const hours = Number(match[1]);
    const minutes = Number(match[2]);
    if (hours > 23 || minutes > 59) return null;
    return hours * 60 + minutes;
  }

  /** 1050 -> "17:30". */
  function formatTime(minutes) {
    const h = Math.floor(minutes / 60);
    const m = minutes % 60;
    return String(h).padStart(2, '0') + ':' + String(m).padStart(2, '0');
  }

  /**
   * Split a daily time window into back-to-back slots, repeated over each date.
   *
   * @param {Object} opts
   * @param {Array<string>} opts.dates      "YYYY-MM-DD", any order
   * @param {string} opts.startTime         "HH:MM", window opens
   * @param {string} opts.endTime           "HH:MM", window closes
   * @param {number} opts.slotMinutes       length of one session
   * @param {number} opts.gapMinutes        breathing room between sessions
   * @return {{slots: Array, perDay: number, leftoverMinutes: number,
   *           problems: Array<string>}}
   */
  function planSlots(opts) {
    const o = opts || {};
    const problems = [];

    const dates = [...new Set(o.dates || [])].sort();
    const startM = parseTime(o.startTime);
    const endM = parseTime(o.endTime);
    const slotMinutes = Number(o.slotMinutes);
    const gapMinutes = Number(o.gapMinutes) || 0;

    if (!dates.length) problems.push('Pick at least one date on the calendar.');
    if (startM === null || endM === null) problems.push('Set a start and end time for the window.');
    if (!(slotMinutes >= MIN_SLOT_MINUTES)) {
      problems.push(`Each session must be at least ${MIN_SLOT_MINUTES} minutes long.`);
    }
    if (gapMinutes < 0) problems.push('The gap between sessions cannot be negative.');

    if (startM !== null && endM !== null && endM <= startM) {
      problems.push('The window has to end after it starts.');
    }
    if (problems.length) return { slots: [], perDay: 0, leftoverMinutes: 0, problems };

    // One day's worth of slots, then stamped onto every selected date.
    const windows = [];
    const step = slotMinutes + gapMinutes;
    for (let cursor = startM; cursor + slotMinutes <= endM; cursor += step) {
      windows.push({ startTime: formatTime(cursor), endTime: formatTime(cursor + slotMinutes) });
    }

    if (!windows.length) {
      problems.push(
        `A ${slotMinutes}-minute session does not fit between ${o.startTime} and ${o.endTime}.`);
      return { slots: [], perDay: 0, leftoverMinutes: 0, problems };
    }

    // Whatever is left after the last full slot. A partial session is never
    // published; the caller tells the user how much time it is leaving unused.
    const lastEnd = parseTime(windows[windows.length - 1].endTime);
    const leftoverMinutes = endM - lastEnd;

    const slots = [];
    dates.forEach((date) => {
      windows.forEach((w) => {
        slots.push({ date, startTime: w.startTime, endTime: w.endTime });
      });
    });

    return { slots, perDay: windows.length, leftoverMinutes, problems: [] };
  }

  /* ---- Multi-date month picker ----------------------------------------- */

  const DAY_NAMES = ['Su', 'Mo', 'Tu', 'We', 'Th', 'Fr', 'Sa'];
  const MONTH_NAMES = ['January', 'February', 'March', 'April', 'May', 'June',
    'July', 'August', 'September', 'October', 'November', 'December'];

  /** "YYYY-MM-DD" for today in the course timezone, so "past" means past there. */
  function todayInZone(timeZone) {
    return new Intl.DateTimeFormat('en-CA', {
      timeZone, year: 'numeric', month: '2-digit', day: '2-digit'
    }).format(new Date());
  }

  function isoDate(year, month, day) {
    return year + '-' + String(month + 1).padStart(2, '0') + '-' + String(day).padStart(2, '0');
  }

  /** Sep 8 -> "Tue, Sep 8". Parsed as UTC so it never slides a day. */
  function labelDate(iso) {
    const d = new Date(iso + 'T12:00:00Z');
    return new Intl.DateTimeFormat('en-US', {
      timeZone: 'UTC', weekday: 'short', month: 'short', day: 'numeric'
    }).format(d);
  }

  /**
   * A month grid you click dates on. Shift-click extends from the last date you
   * clicked, which is the difference between picking a two-week block in one
   * gesture and doing it fourteen times.
   *
   * @param {HTMLElement} mount
   * @param {{timeZone: string, onChange: function(Array<string>)}} opts
   */
  function createDatePicker(mount, opts) {
    const timeZone = (opts && opts.timeZone) || 'America/Chicago';
    const onChange = (opts && opts.onChange) || function () {};
    const today = todayInZone(timeZone);

    const selected = new Set();
    let anchor = null;                       // last plain click, for shift-ranges
    let view = { year: Number(today.slice(0, 4)), month: Number(today.slice(5, 7)) - 1 };

    function notify() {
      onChange(getSelected());
    }

    function getSelected() {
      return [...selected].sort();
    }

    function selectRange(from, to) {
      const [lo, hi] = from <= to ? [from, to] : [to, from];
      const cursor = new Date(lo + 'T12:00:00Z');
      const end = new Date(hi + 'T12:00:00Z');
      while (cursor <= end) {
        const iso = cursor.toISOString().slice(0, 10);
        if (iso >= today) selected.add(iso);
        cursor.setUTCDate(cursor.getUTCDate() + 1);
      }
    }

    function onCellClick(event) {
      const cell = event.target.closest('[data-date]');
      if (!cell || cell.disabled) return;
      const iso = cell.dataset.date;
      // The button is rendered disabled, but the set itself is what feeds the
      // publish, so guard it here too rather than trusting the markup.
      if (iso < today) return;

      if (event.shiftKey && anchor) {
        selectRange(anchor, iso);
      } else if (selected.has(iso)) {
        selected.delete(iso);
        anchor = iso;
      } else {
        selected.add(iso);
        anchor = iso;
      }

      render();
      notify();
    }

    function render() {
      const { year, month } = view;
      const firstWeekday = new Date(Date.UTC(year, month, 1)).getUTCDay();
      const daysInMonth = new Date(Date.UTC(year, month + 1, 0)).getUTCDate();

      const cells = [];
      for (let i = 0; i < firstWeekday; i++) cells.push('<td></td>');
      for (let day = 1; day <= daysInMonth; day++) {
        const iso = isoDate(year, month, day);
        const past = iso < today;
        const on = selected.has(iso);
        cells.push(
          `<td><button type="button" class="daypick${on ? ' is-on' : ''}"
                       data-date="${iso}" ${past ? 'disabled' : ''}
                       aria-pressed="${on}"
                       aria-label="${labelDate(iso)}">${day}</button></td>`);
      }
      while (cells.length % 7) cells.push('<td></td>');

      const weeks = [];
      for (let i = 0; i < cells.length; i += 7) {
        weeks.push('<tr>' + cells.slice(i, i + 7).join('') + '</tr>');
      }

      const chosen = getSelected();
      mount.innerHTML = `
        <div class="daypicker">
          <div class="daypicker-head">
            <button type="button" class="btn btn-ghost btn-sm" data-month="-1"
                    aria-label="Previous month">&larr;</button>
            <strong>${MONTH_NAMES[month]} ${year}</strong>
            <button type="button" class="btn btn-ghost btn-sm" data-month="1"
                    aria-label="Next month">&rarr;</button>
          </div>
          <table class="daypicker-grid">
            <thead><tr>${DAY_NAMES.map((d) => `<th scope="col">${d}</th>`).join('')}</tr></thead>
            <tbody>${weeks.join('')}</tbody>
          </table>
          <p class="daypicker-hint">Click to select. Shift-click for a run of days.</p>
          <div class="daypicker-chosen">
            ${chosen.length
              ? chosen.map((iso) => `
                  <button type="button" class="chip" data-drop="${iso}">
                    ${labelDate(iso)} <span aria-hidden="true">&times;</span>
                    <span class="sr-only">Remove</span>
                  </button>`).join('') +
                '<button type="button" class="btn btn-ghost btn-sm" data-clear>Clear all</button>'
              : '<span class="small muted">No dates selected yet.</span>'}
          </div>
        </div>`;
    }

    mount.addEventListener('click', (event) => {
      const month = event.target.closest('[data-month]');
      if (month) {
        view.month += Number(month.dataset.month);
        if (view.month < 0) { view.month = 11; view.year--; }
        if (view.month > 11) { view.month = 0; view.year++; }
        return render();
      }

      const drop = event.target.closest('[data-drop]');
      if (drop) {
        selected.delete(drop.dataset.drop);
        render();
        return notify();
      }

      if (event.target.closest('[data-clear]')) {
        selected.clear();
        anchor = null;
        render();
        return notify();
      }

      onCellClick(event);
    });

    render();

    return {
      getSelected,
      clear() {
        selected.clear();
        anchor = null;
        render();
        notify();
      }
    };
  }

  return { planSlots, parseTime, formatTime, createDatePicker, labelDate, MIN_SLOT_MINUTES };
})();

if (typeof window !== 'undefined') window.BulkSessions = BulkSessions;
if (typeof module !== 'undefined' && module.exports) module.exports = BulkSessions;
