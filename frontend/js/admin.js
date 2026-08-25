/* ==========================================================================
   admin.js - instructor panel: publish sessions, read rosters, cancel sessions.

   The gate below is UX only. Every action here is re-checked against the
   Teachers allow-list server-side, so a determined visitor who un-hides the
   form still gets a FORBIDDEN back.

   The form publishes either one session or a whole batch. Bulk is purely an
   instructor convenience - it changes nothing about how students book, which
   is still one seat at a time from an ordinary session card.
   ========================================================================== */

(function () {
  /** Must match MAX_BULK_SESSIONS in apps-script/Constants.js. */
  const MAX_BULK = 40;

  const els = {
    gate: document.querySelector('#gate'),
    panel: document.querySelector('#admin'),
    form: document.querySelector('#create-form'),
    submit: document.querySelector('#create-submit'),
    status: document.querySelector('#create-status'),
    course: document.querySelector('#courseId'),
    sessionType: document.querySelector('#sessionType'),
    teacher: document.querySelector('#teacherEmail'),
    date: document.querySelector('#date'),
    start: document.querySelector('#startTime'),
    end: document.querySelector('#endTime'),
    tzHint: document.querySelector('#tz-hint'),
    tzHintBulk: document.querySelector('#tz-hint-bulk'),
    datePicker: document.querySelector('#date-picker'),
    windowStart: document.querySelector('#windowStart'),
    windowEnd: document.querySelector('#windowEnd'),
    slotMinutes: document.querySelector('#slotMinutes'),
    gapMinutes: document.querySelector('#gapMinutes'),
    preview: document.querySelector('#preview'),
    events: document.querySelector('#events'),
    showPast: document.querySelector('#show-past'),
    refresh: document.querySelector('#refresh-events')
  };

  let events = [];
  let optionsLoaded = false;
  let mode = 'single';
  let picker = null;
  let plan = { slots: [], problems: [], perDay: 0, leftoverMinutes: 0 };
  let signedInEmail = '';

  const zone = () =>
    (window.APP_CONFIG && window.APP_CONFIG.DISPLAY_TIMEZONE) || 'America/Chicago';

  /* ---- Gate ------------------------------------------------------------ */

  function showGate(snapshot) {
    if (!snapshot.signedIn) {
      els.panel.hidden = true;
      Auth.renderSignInPrompt(els.gate, 'Instructor sign-in required. Use your Rice account.');
      return false;
    }

    if (!snapshot.resolved) {
      els.gate.innerHTML = UI.skeletons(1);
      els.panel.hidden = true;
      return false;
    }

    if (!snapshot.isTeacher) {
      els.panel.hidden = true;
      els.gate.innerHTML = `
        <div class="alert alert-warning">
          <div>
            <strong>Instructor access only</strong>
            You are signed in as ${UI.esc(snapshot.email)}, which is not on the course staff
            list. If you should have access, ask for your address to be added to the
            <strong>Teachers</strong> tab of the booking spreadsheet.
          </div>
        </div>
        ${UI.emptyState(
          'Looking for a session to attend?',
          'Students book from the Book a Slot page.',
          '<a class="btn btn-sm" href="book.html">Browse open sessions</a>')}`;
      return false;
    }

    els.gate.innerHTML = '';
    els.panel.hidden = false;
    return true;
  }

  /* ---- Form options ---------------------------------------------------- */

  async function loadFormOptions(snapshot) {
    if (optionsLoaded) return;
    optionsLoaded = true;
    signedInEmail = snapshot.email || '';

    try {
      const data = await Api.listCourses();
      els.course.innerHTML = (data.courses || [])
        .map((c) => `<option value="${UI.esc(c.courseId)}">${UI.esc(c.courseName || c.courseId)}</option>`)
        .join('');

      els.sessionType.innerHTML = '<option value="">(none)</option>' +
        (data.sessionTypes || [])
          .map((t) => `<option value="${UI.esc(t)}">${UI.esc(t)}</option>`)
          .join('');
    } catch (e) {
      UI.toast('Could not load the course list: ' + (e.message || e), 'error', 8000);
    }

    // Instructor dropdown: default to the signed-in teacher, but any active
    // teacher can be assigned the session.
    els.teacher.innerHTML = `<option value="">${UI.esc(snapshot.name || snapshot.email)} (me)</option>`;
    try {
      const data = await Api.listTeachers();
      (data.teachers || [])
        .filter((t) => t.email !== snapshot.email)
        .forEach((t) => {
          const option = document.createElement('option');
          option.value = t.email;
          option.textContent = `${t.name} (${t.email})`;
          els.teacher.appendChild(option);
        });
    } catch (e) {
      console.warn('Could not load the teacher list:', e);
    }

    presetDateTimes();
    initPicker();
  }

  /** Sensible defaults: tomorrow, 10:00–11:00, in the course timezone. */
  function presetDateTimes() {
    const tomorrow = new Date(Date.now() + 86400000);
    const parts = new Intl.DateTimeFormat('en-CA', {
      timeZone: zone(), year: 'numeric', month: '2-digit', day: '2-digit'
    }).format(tomorrow);

    if (!els.date.value) els.date.value = parts;
    if (!els.start.value) els.start.value = '10:00';
    if (!els.end.value) els.end.value = '11:00';

    const label = new Intl.DateTimeFormat('en-US', { timeZone: zone(), timeZoneName: 'long' })
      .formatToParts(new Date()).find((p) => p.type === 'timeZoneName');
    const hint = label ? `Times are ${label.value}.` : '';
    els.tzHint.textContent = hint;
    els.tzHintBulk.textContent = hint;
  }

  function initPicker() {
    if (picker) return;
    picker = BulkSessions.createDatePicker(els.datePicker, {
      timeZone: zone(),
      onChange: renderPreview
    });
  }

  /* ---- Single / bulk mode --------------------------------------------- */

  function applyMode(next) {
    mode = next;
    els.form.querySelectorAll('[data-mode]').forEach((node) => {
      node.hidden = node.dataset.mode !== mode;
    });
    if (mode === 'bulk') renderPreview();
    else updateSubmitLabel();
  }

  function updateSubmitLabel() {
    if (mode === 'single') {
      els.submit.textContent = 'Publish session';
      els.submit.disabled = false;
      return;
    }
    const count = chosenSlots().length;
    els.submit.textContent = count
      ? `Publish ${count} session${count === 1 ? '' : 's'}`
      : 'Publish sessions';
    els.submit.disabled = count === 0;
  }

  function chosenSlots() {
    return plan.slots.filter((slot) => slot.selected && !slot.past);
  }

  /* ---- Bulk preview ---------------------------------------------------- */

  /**
   * An existing session by the same instructor that this slot would collide
   * with. A warning, not a block - double-booking a room is sometimes exactly
   * what you meant, but it should never happen without you noticing.
   */
  function findClash(startIso, endIso, teacherEmail) {
    const from = new Date(startIso).getTime();
    const to = new Date(endIso).getTime();
    const who = (teacherEmail || signedInEmail || '').toLowerCase();

    return events.find((event) => {
      if (event.status !== 'ACTIVE' || event.isPast) return false;
      if (who && event.teacherEmail !== who) return false;
      const start = new Date(event.startDateTime).getTime();
      const end = new Date(event.endDateTime).getTime();
      return from < end && start < to;
    }) || null;
  }

  function buildPlan() {
    const draft = BulkSessions.planSlots({
      dates: picker ? picker.getSelected() : [],
      startTime: els.windowStart.value,
      endTime: els.windowEnd.value,
      slotMinutes: Number(els.slotMinutes.value),
      gapMinutes: Number(els.gapMinutes.value)
    });

    if (draft.problems.length) {
      return { slots: [], problems: draft.problems, perDay: 0, leftoverMinutes: 0 };
    }

    const teacherEmail = els.teacher.value;
    const now = Date.now();

    const slots = draft.slots.map((slot) => {
      const startDateTime = UI.localInputToIso(slot.date, slot.startTime);
      const endDateTime = UI.localInputToIso(slot.date, slot.endTime);
      const past = !startDateTime || new Date(startDateTime).getTime() <= now;
      return {
        ...slot,
        startDateTime,
        endDateTime,
        past,
        clash: past ? null : findClash(startDateTime, endDateTime, teacherEmail),
        // Slots already in the past are never published; unticking them is not
        // a decision anyone should have to make by hand.
        selected: !past
      };
    });

    return { slots, problems: [], perDay: draft.perDay, leftoverMinutes: draft.leftoverMinutes };
  }

  function renderPreview() {
    if (mode !== 'bulk') return;
    plan = buildPlan();

    if (plan.problems.length) {
      els.preview.innerHTML = `
        <div class="bulk-preview is-empty">
          ${plan.problems.map((p) => `<p class="small muted">${UI.esc(p)}</p>`).join('')}
        </div>`;
      updateSubmitLabel();
      return;
    }

    const byDate = new Map();
    plan.slots.forEach((slot, index) => {
      if (!byDate.has(slot.date)) byDate.set(slot.date, []);
      byDate.get(slot.date).push({ slot, index });
    });

    const days = [...byDate.entries()].map(([date, entries]) => `
      <div class="bulk-day">
        <div class="bulk-day-label">${UI.esc(BulkSessions.labelDate(date))}</div>
        <div class="bulk-day-slots">
          ${entries.map(({ slot, index }) => `
            <label class="bulk-slot${slot.past ? ' is-past' : ''}${slot.clash ? ' is-clash' : ''}">
              <input type="checkbox" data-slot="${index}"
                     ${slot.selected ? 'checked' : ''} ${slot.past ? 'disabled' : ''}>
              <span>${UI.esc(UI.fmtTime(slot.startDateTime))} – ${UI.esc(UI.fmtTime(slot.endDateTime))}</span>
              ${slot.past ? '<span class="bulk-flag">past</span>' : ''}
              ${slot.clash
                ? `<span class="bulk-flag bulk-flag-warn" title="Overlaps ${UI.esc(slot.clash.title)}">clashes</span>`
                : ''}
            </label>`).join('')}
        </div>
      </div>`).join('');

    const notes = [];
    notes.push(`${plan.perDay} per day across ${byDate.size} date${byDate.size === 1 ? '' : 's'}`);
    if (plan.leftoverMinutes > 0) {
      notes.push(`${plan.leftoverMinutes} min left over at the end of each day`);
    }
    const clashes = plan.slots.filter((s) => s.clash).length;
    if (clashes) notes.push(`${clashes} overlap an existing session`);
    if (plan.slots.length > MAX_BULK) {
      notes.push(`over the ${MAX_BULK}-session limit for one batch`);
    }

    els.preview.innerHTML = `
      <div class="bulk-preview">
        <div class="bulk-preview-head">
          <strong id="preview-count">${chosenSlots().length} sessions will be created</strong>
          <span class="small muted">${UI.esc(notes.join(' · '))}</span>
        </div>
        ${days}
      </div>`;

    updateSubmitLabel();
  }

  function updatePreviewCount() {
    const label = els.preview.querySelector('#preview-count');
    const count = chosenSlots().length;
    if (label) label.textContent = `${count} session${count === 1 ? '' : 's'} will be created`;
    updateSubmitLabel();
  }

  /* ---- Create ---------------------------------------------------------- */

  function sharedValues(form) {
    return {
      courseId: String(form.get('courseId') || ''),
      title: String(form.get('title') || '').trim(),
      sessionType: String(form.get('sessionType') || ''),
      description: String(form.get('description') || '').trim(),
      location: String(form.get('location') || '').trim(),
      capacity: Number(form.get('capacity')),
      teacherEmail: String(form.get('teacherEmail') || '')
    };
  }

  function validate(values) {
    const problems = [];
    if (!values.courseId) problems.push('Choose a course.');
    if (!values.title) problems.push('Give the session a title.');
    if (!(values.capacity >= 1)) problems.push('Capacity must be at least 1.');
    return problems;
  }

  function validateSingle(values) {
    const problems = validate(values);
    if (!values.startDateTime || !values.endDateTime) problems.push('Set a date, start and end time.');
    else if (new Date(values.endDateTime) <= new Date(values.startDateTime)) {
      problems.push('The end time must be after the start time.');
    } else if (new Date(values.startDateTime).getTime() <= Date.now()) {
      problems.push('The session must start in the future.');
    }
    return problems;
  }

  async function submit(e) {
    e.preventDefault();
    const form = new FormData(els.form);
    const values = sharedValues(form);

    if (mode === 'single') {
      values.startDateTime = UI.localInputToIso(form.get('date'), form.get('startTime'));
      values.endDateTime = UI.localInputToIso(form.get('date'), form.get('endTime'));

      const problems = validateSingle(values);
      if (problems.length) return UI.toast(problems[0], 'warning');

      return publish(
        () => Api.createEvent(values),
        (result) => {
          UI.toast(`"${result.event.title}" is published and open for booking.`, 'success', 8000);
          return 'Published ' + UI.fmtRange(result.event.startDateTime, result.event.endDateTime);
        },
        'Publishing…'
      );
    }

    const problems = validate(values);
    const slots = chosenSlots();
    if (!slots.length) problems.push('No sessions are ticked in the preview.');
    if (slots.length > MAX_BULK) {
      problems.push(
        `That is ${slots.length} sessions. Publish at most ${MAX_BULK} at a time - ` +
        'untick some and run a second batch for the rest.');
    }
    if (problems.length) return UI.toast(problems[0], 'warning', 8000);

    values.slots = slots.map((slot) => ({
      startDateTime: slot.startDateTime,
      endDateTime: slot.endDateTime
    }));

    return publish(
      () => Api.createEvents(values),
      (result) => {
        UI.toast(
          `${result.count} sessions published and open for booking.`, 'success', 8000);
        return `Published ${result.count} sessions`;
      },
      `Publishing ${slots.length}…`
    );
  }

  /** Shared submit plumbing for both modes. */
  async function publish(call, describe, busyLabel) {
    UI.setBusy(els.submit, true, busyLabel);
    els.status.textContent = '';

    try {
      const result = await call();
      els.status.textContent = describe(result);

      // Stay in whichever mode they were in. Anyone publishing a batch is
      // likely publishing another - a schedule over the per-batch limit has to
      // be sent in two goes - and being thrown back to the single form each
      // time would be exactly wrong.
      const keepMode = mode;
      els.form.reset();
      if (picker) picker.clear();
      presetDateTimes();
      els.form.querySelector(`[name="mode"][value="${keepMode}"]`).checked = true;
      applyMode(keepMode);

      await loadEvents({ quiet: true });
    } catch (err) {
      UI.toast((err && err.message) || 'Could not publish that.', 'error', 10000);
      // The table is the source of truth for what actually landed - worth a
      // refresh even on failure, in case the request completed after we gave up.
      await loadEvents({ quiet: true });
    } finally {
      UI.setBusy(els.submit, false);
      updateSubmitLabel();
    }
  }

  /* ---- Events table ---------------------------------------------------- */

  async function loadEvents({ quiet = false } = {}) {
    if (!quiet) els.events.innerHTML = UI.skeletons(2);
    const includePast = els.showPast.checked;

    try {
      const data = await Api.listEvents({
        includePast: includePast ? 'true' : '',
        includeCancelled: includePast ? 'true' : ''
      });
      events = data.events || [];
      renderEvents();
      // Clash warnings are drawn from this list, so the preview is stale now.
      if (mode === 'bulk') renderPreview();
    } catch (e) {
      els.events.innerHTML = UI.errorPanel(e);
    }
  }

  function statusBadge(event) {
    if (event.status === 'CANCELLED') return '<span class="badge badge-cancelled">Cancelled</span>';
    if (event.isPast) return '<span class="badge badge-past">Past</span>';
    if (event.seatsRemaining <= 0) return '<span class="badge badge-full">Full</span>';
    return `<span class="badge badge-open">${event.seatsRemaining} open</span>`;
  }

  /** How many sessions of each batch are still standing and still cancellable. */
  function liveSeriesCounts() {
    const counts = {};
    events.forEach((event) => {
      if (!event.seriesId || event.status !== 'ACTIVE' || event.isPast) return;
      counts[event.seriesId] = (counts[event.seriesId] || 0) + 1;
    });
    return counts;
  }

  function renderEvents() {
    if (!events.length) {
      els.events.innerHTML = UI.emptyState(
        'No sessions yet',
        els.showPast.checked
          ? 'Nothing has been published on this calendar.'
          : 'Nothing upcoming. Tick "Include past & cancelled" to see history.'
      );
      return;
    }

    const seriesCounts = liveSeriesCounts();

    const rows = events.map((event) => {
      const manageable = event.status === 'ACTIVE' && !event.isPast;
      const inBatch = manageable && event.seriesId && seriesCounts[event.seriesId] > 1;
      return `
        <tr class="${event.status === 'CANCELLED' ? 'row-cancelled' : ''}">
          <td>
            <strong>${UI.esc(event.title)}</strong>
            ${inBatch
              ? `<span class="badge badge-series">batch of ${seriesCounts[event.seriesId]}</span>`
              : ''}<br>
            <span class="small muted">${UI.esc(event.sessionType || '')}${
              event.location ? ' · ' + UI.esc(event.location) : ''}</span>
          </td>
          <td><span class="badge badge-course" data-course="${UI.esc(event.courseId)}">${UI.esc(event.courseId)}</span></td>
          <td class="nowrap">
            ${UI.esc(UI.fmtDate(event.startDateTime))}<br>
            <span class="small muted">${UI.esc(UI.fmtTime(event.startDateTime))} – ${UI.esc(UI.fmtTime(event.endDateTime))}</span>
          </td>
          <td>${UI.esc(event.teacherName || event.teacherEmail)}</td>
          <td class="nowrap"><strong>${event.bookedCount}</strong> <span class="muted">/ ${event.capacity}</span></td>
          <td>${statusBadge(event)}</td>
          <td class="actions">
            <button class="btn btn-secondary btn-sm" type="button"
                    data-roster="${UI.esc(event.eventId)}">Roster</button>
            ${manageable
              ? `<button class="btn btn-ghost btn-sm" type="button"
                         data-cancel-event="${UI.esc(event.eventId)}">Cancel</button>`
              : ''}
            ${inBatch
              ? `<button class="btn btn-ghost btn-sm" type="button"
                         data-cancel-series="${UI.esc(event.seriesId)}">Cancel batch</button>`
              : ''}
          </td>
        </tr>`;
    }).join('');

    els.events.innerHTML = `
      <div class="table-wrap">
        <table class="data">
          <thead>
            <tr>
              <th scope="col">Session</th>
              <th scope="col">Course</th>
              <th scope="col">When</th>
              <th scope="col">Instructor</th>
              <th scope="col">Booked</th>
              <th scope="col">Status</th>
              <th scope="col"><span class="sr-only">Actions</span></th>
            </tr>
          </thead>
          <tbody>${rows}</tbody>
        </table>
      </div>`;
  }

  /* ---- Roster ---------------------------------------------------------- */

  async function showRoster(eventId, button) {
    UI.setBusy(button, true, '…');

    try {
      const data = await Api.getRoster(eventId);
      const roster = data.roster || [];
      const emails = roster.map((r) => r.studentEmail).join(', ');

      const body = roster.length
        ? `<div class="table-wrap">
             <table class="data">
               <thead><tr><th scope="col">#</th><th scope="col">Student</th><th scope="col">Booked</th></tr></thead>
               <tbody>${roster.map((r, i) => `
                 <tr>
                   <td>${i + 1}</td>
                   <td><strong>${UI.esc(r.studentName)}</strong><br>
                       <span class="small muted">${UI.esc(r.studentEmail)}</span></td>
                   <td class="nowrap small muted">${UI.esc(UI.fmtDate(r.bookedAt))}</td>
                 </tr>`).join('')}</tbody>
             </table>
           </div>`
        : UI.emptyState('No bookings yet', 'Nobody has taken a seat in this session so far.');

      UI.modal({
        title: data.event.title,
        subtitle: `${UI.fmtRange(data.event.startDateTime, data.event.endDateTime)} · ` +
                  `${roster.length} of ${data.event.capacity} seats taken`,
        body,
        footer: roster.length
          ? `<button class="btn btn-secondary" type="button" data-copy>Copy email addresses</button>
             <button class="btn" type="button" data-close>Close</button>`
          : '<button class="btn" type="button" data-close>Close</button>',
        onMount(root, close) {
          const closeBtn = root.querySelector('[data-close]');
          if (closeBtn) closeBtn.addEventListener('click', close);

          const copyBtn = root.querySelector('[data-copy]');
          if (copyBtn) {
            copyBtn.addEventListener('click', async () => {
              try {
                await navigator.clipboard.writeText(emails);
                UI.toast(`Copied ${roster.length} email address${roster.length === 1 ? '' : 'es'}.`, 'success', 4000);
              } catch (e) {
                UI.toast('Could not copy automatically - select the addresses manually.', 'warning');
              }
            });
          }
        }
      });
    } catch (e) {
      UI.toast((e && e.message) || 'Could not load that roster.', 'error', 8000);
    } finally {
      UI.setBusy(button, false);
    }
  }

  /* ---- Cancel a session ------------------------------------------------ */

  async function cancelEvent(eventId, button) {
    const event = events.find((ev) => ev.eventId === eventId);
    if (!event) return;

    const confirmed = await UI.confirmDialog({
      title: 'Cancel this session?',
      subtitle: event.title,
      message: event.bookedCount > 0
        ? `${event.bookedCount} student${event.bookedCount === 1 ? '' : 's'} will be emailed and ` +
          'the event will disappear from their calendars.'
        : 'Nobody has booked this session yet, so no students will be notified.',
      detail: 'This cannot be undone - you would have to publish the session again.',
      confirmLabel: 'Yes, cancel the session',
      cancelLabel: 'Keep it',
      danger: true
    });
    if (!confirmed) return;

    UI.setBusy(button, true, '…');

    try {
      const result = await Api.cancelEvent(eventId);
      UI.toast(
        result.notified > 0
          ? `Session cancelled. ${result.notified} student${result.notified === 1 ? '' : 's'} notified.`
          : 'Session cancelled.',
        'success', 8000
      );
      if (result.calendarUpdated === false) {
        UI.toast(
          'The calendar event could not be deleted automatically - please remove it by hand.',
          'warning', 12000
        );
      }
      await loadEvents({ quiet: true });
    } catch (e) {
      UI.setBusy(button, false);
      UI.toast((e && e.message) || 'Could not cancel that session.', 'error', 8000);
    }
  }

  /* ---- Cancel a whole batch -------------------------------------------- */

  async function cancelSeries(seriesId, button) {
    const members = events.filter(
      (ev) => ev.seriesId === seriesId && ev.status === 'ACTIVE' && !ev.isPast);
    if (!members.length) return;

    const booked = members.reduce((sum, ev) => sum + ev.bookedCount, 0);

    const confirmed = await UI.confirmDialog({
      title: `Cancel all ${members.length} remaining sessions?`,
      subtitle: members[0].title,
      message: booked > 0
        ? `${booked} booking${booked === 1 ? '' : 's'} across ${members.length} sessions will be ` +
          'cancelled. Every student affected is emailed and the events disappear from their calendars.'
        : `Nobody has booked any of these ${members.length} sessions yet, so no students will be notified.`,
      detail: 'Sessions in this batch that have already happened are left alone. ' +
              'This cannot be undone.',
      confirmLabel: `Yes, cancel all ${members.length}`,
      cancelLabel: 'Keep them',
      danger: true
    });
    if (!confirmed) return;

    UI.setBusy(button, true, '…');

    try {
      const result = await Api.cancelSeries(seriesId);
      UI.toast(
        result.notified > 0
          ? `${result.cancelled} sessions cancelled. ${result.notified} booking${
              result.notified === 1 ? '' : 's'} notified.`
          : `${result.cancelled} sessions cancelled.`,
        'success', 8000
      );
      if (result.calendarUpdated === false) {
        UI.toast(
          'At least one calendar event could not be deleted automatically - please check the calendar.',
          'warning', 12000
        );
      }
      await loadEvents({ quiet: true });
    } catch (e) {
      UI.setBusy(button, false);
      UI.toast((e && e.message) || 'Could not cancel that batch.', 'error', 8000);
    }
  }

  /* ---- Wiring ---------------------------------------------------------- */

  document.addEventListener('DOMContentLoaded', () => {
    UI.initChrome();

    els.form.addEventListener('submit', submit);
    els.refresh.addEventListener('click', () => loadEvents());
    els.showPast.addEventListener('change', () => loadEvents());

    els.form.addEventListener('change', (e) => {
      if (e.target.name === 'mode') return applyMode(e.target.value);
      // Anything that feeds the plan invalidates the preview, including the
      // instructor dropdown - clash warnings are per-instructor.
      if (mode === 'bulk' &&
          ['windowStart', 'windowEnd', 'slotMinutes', 'gapMinutes', 'teacherEmail']
            .includes(e.target.name)) {
        renderPreview();
      }
    });

    // Ticking a slot only moves the count; re-rendering here would yank focus.
    els.preview.addEventListener('change', (e) => {
      const box = e.target.closest('[data-slot]');
      if (!box) return;
      plan.slots[Number(box.dataset.slot)].selected = box.checked;
      updatePreviewCount();
    });

    els.form.addEventListener('reset', () => {
      // The reset lands after this handler, so restore defaults on the next
      // tick - and follow whatever the mode radio ends up saying rather than
      // forcing it, so a publish can keep the user where they were.
      setTimeout(() => {
        if (picker) picker.clear();
        presetDateTimes();
        const chosen = els.form.querySelector('[name="mode"]:checked');
        applyMode(chosen ? chosen.value : 'single');
      }, 0);
    });

    els.events.addEventListener('click', (e) => {
      const roster = e.target.closest('[data-roster]');
      if (roster) return showRoster(roster.dataset.roster, roster);
      const cancel = e.target.closest('[data-cancel-event]');
      if (cancel) return cancelEvent(cancel.dataset.cancelEvent, cancel);
      const series = e.target.closest('[data-cancel-series]');
      if (series) return cancelSeries(series.dataset.cancelSeries, series);
    });

    let wasTeacher = null;
    Auth.onChange((snapshot) => {
      const allowed = showGate(snapshot);
      if (allowed && wasTeacher !== true) {
        wasTeacher = true;
        loadFormOptions(snapshot);
        loadEvents();
      } else if (!allowed) {
        wasTeacher = false;
      }
    });

    Auth.init();
  });
})();
