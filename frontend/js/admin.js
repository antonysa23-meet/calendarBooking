/* ==========================================================================
   admin.js - instructor panel: publish sessions, read rosters, cancel sessions.

   The gate below is UX only. Every action here is re-checked against the
   Teachers allow-list server-side, so a determined visitor who un-hides the
   form still gets a FORBIDDEN back.
   ========================================================================== */

(function () {
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
    events: document.querySelector('#events'),
    showPast: document.querySelector('#show-past'),
    refresh: document.querySelector('#refresh-events')
  };

  let events = [];
  let optionsLoaded = false;

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
  }

  /** Sensible defaults: tomorrow, 10:00–11:00, in the course timezone. */
  function presetDateTimes() {
    const zone = (window.APP_CONFIG && window.APP_CONFIG.DISPLAY_TIMEZONE) || 'America/Chicago';
    const tomorrow = new Date(Date.now() + 86400000);
    const parts = new Intl.DateTimeFormat('en-CA', {
      timeZone: zone, year: 'numeric', month: '2-digit', day: '2-digit'
    }).format(tomorrow);

    if (!els.date.value) els.date.value = parts;
    if (!els.start.value) els.start.value = '10:00';
    if (!els.end.value) els.end.value = '11:00';

    const label = new Intl.DateTimeFormat('en-US', { timeZone: zone, timeZoneName: 'long' })
      .formatToParts(new Date()).find((p) => p.type === 'timeZoneName');
    els.tzHint.textContent = label ? `Times are ${label.value}.` : '';
  }

  /* ---- Create ---------------------------------------------------------- */

  function validate(values) {
    const problems = [];
    if (!values.courseId) problems.push('Choose a course.');
    if (!values.title) problems.push('Give the session a title.');
    if (!values.startDateTime || !values.endDateTime) problems.push('Set a date, start and end time.');
    else if (new Date(values.endDateTime) <= new Date(values.startDateTime)) {
      problems.push('The end time must be after the start time.');
    } else if (new Date(values.startDateTime).getTime() <= Date.now()) {
      problems.push('The session must start in the future.');
    }
    if (!(values.capacity >= 1)) problems.push('Capacity must be at least 1.');
    return problems;
  }

  async function submit(e) {
    e.preventDefault();
    const form = new FormData(els.form);

    const values = {
      courseId: String(form.get('courseId') || ''),
      title: String(form.get('title') || '').trim(),
      sessionType: String(form.get('sessionType') || ''),
      description: String(form.get('description') || '').trim(),
      location: String(form.get('location') || '').trim(),
      capacity: Number(form.get('capacity')),
      teacherEmail: String(form.get('teacherEmail') || ''),
      startDateTime: UI.localInputToIso(form.get('date'), form.get('startTime')),
      endDateTime: UI.localInputToIso(form.get('date'), form.get('endTime'))
    };

    const problems = validate(values);
    if (problems.length) {
      UI.toast(problems[0], 'warning');
      return;
    }

    UI.setBusy(els.submit, true, 'Publishing…');
    els.status.textContent = '';

    try {
      const result = await Api.createEvent(values);
      UI.toast(`"${result.event.title}" is published and open for booking.`, 'success', 8000);
      els.status.textContent = 'Published ' + UI.fmtRange(
        result.event.startDateTime, result.event.endDateTime);

      els.form.reset();
      presetDateTimes();
      await loadEvents({ quiet: true });
    } catch (err) {
      UI.toast((err && err.message) || 'Could not publish that session.', 'error', 10000);
    } finally {
      UI.setBusy(els.submit, false);
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

    const rows = events.map((event) => {
      const manageable = event.status === 'ACTIVE' && !event.isPast;
      return `
        <tr class="${event.status === 'CANCELLED' ? 'row-cancelled' : ''}">
          <td>
            <strong>${UI.esc(event.title)}</strong><br>
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

  /* ---- Wiring ---------------------------------------------------------- */

  document.addEventListener('DOMContentLoaded', () => {
    UI.initChrome();

    els.form.addEventListener('submit', submit);
    els.refresh.addEventListener('click', () => loadEvents());
    els.showPast.addEventListener('change', () => loadEvents());

    els.events.addEventListener('click', (e) => {
      const roster = e.target.closest('[data-roster]');
      if (roster) return showRoster(roster.dataset.roster, roster);
      const cancel = e.target.closest('[data-cancel-event]');
      if (cancel) return cancelEvent(cancel.dataset.cancelEvent, cancel);
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
