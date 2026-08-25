/* ==========================================================================
   my-bookings.js - the student's own seats, and releasing them.
   ========================================================================== */

(function () {
  const content = document.querySelector('#content');
  let data = { upcoming: [], past: [] };

  /* ---- Data ------------------------------------------------------------ */

  async function load() {
    if (!Auth.getToken()) {
      Auth.renderSignInPrompt(content, 'Sign in to see the sessions you are booked into.');
      return;
    }

    content.innerHTML = UI.skeletons(2);

    try {
      data = await Api.listMyBookings({ includeCancelled: true });
      render();
    } catch (e) {
      if (e && e.code === 'UNAUTHENTICATED') {
        Auth.renderSignInPrompt(content, 'Your sign-in expired. Please sign in again.');
        return;
      }
      content.innerHTML = UI.errorPanel(e);
    }
  }

  /* ---- Rendering ------------------------------------------------------- */

  function render() {
    const upcoming = data.upcoming || [];
    const past = data.past || [];

    if (!upcoming.length && !past.length) {
      content.innerHTML = UI.emptyState(
        'You have not booked anything yet',
        'Open sessions appear on the Book a Slot page, with live seat counts.',
        '<a class="btn btn-sm" href="book.html">Browse open sessions</a>'
      );
      return;
    }

    content.innerHTML = `
      <section class="section">
        <div class="section-head">
          <div>
            <h2>Upcoming</h2>
            <p class="section-sub">${upcoming.length
              ? `${upcoming.length} session${upcoming.length === 1 ? '' : 's'} booked.`
              : 'Nothing coming up.'}</p>
          </div>
          <a class="btn btn-secondary btn-sm" href="book.html">Book another</a>
        </div>
        ${upcoming.length
          ? `<div class="card-grid">${upcoming.map(upcomingCard).join('')}</div>`
          : UI.emptyState(
              'No upcoming sessions',
              'You are not booked into anything at the moment.',
              '<a class="btn btn-sm" href="book.html">Find a session</a>')}
      </section>

      ${past.length ? historySection(past) : ''}`;
  }

  function upcomingCard(item) {
    return UI.sessionCard(item.event, {
      booked: true,
      actionHtml: `<button class="btn btn-secondary btn-sm" type="button"
        data-cancel="${UI.esc(item.bookingId)}">Cancel my seat</button>`
    });
  }

  function historySection(past) {
    const rows = past.map((item) => {
      const cancelled = item.status === 'CANCELLED';
      const eventCancelled = item.event.status === 'CANCELLED';
      let badge = '<span class="badge badge-past">Attended / past</span>';
      if (eventCancelled) badge = '<span class="badge badge-cancelled">Session cancelled</span>';
      else if (cancelled) badge = '<span class="badge badge-cancelled">You cancelled</span>';

      return `
        <tr class="${cancelled || eventCancelled ? 'row-cancelled' : ''}">
          <td>
            <strong>${UI.esc(item.event.title)}</strong><br>
            <span class="small muted">${UI.esc(item.event.sessionType || '')}</span>
          </td>
          <td><span class="badge badge-course" data-course="${UI.esc(item.event.courseId)}">${UI.esc(item.event.courseId)}</span></td>
          <td class="nowrap">${UI.esc(UI.fmtDate(item.event.startDateTime))}<br>
              <span class="small muted">${UI.esc(UI.fmtTime(item.event.startDateTime))}</span></td>
          <td>${UI.esc(item.event.teacherName || item.event.teacherEmail)}</td>
          <td>${badge}</td>
        </tr>`;
    }).join('');

    return `
      <section class="section">
        <div class="section-head">
          <div>
            <h2>History</h2>
            <p class="section-sub">Past sessions and anything you or your instructor cancelled.</p>
          </div>
        </div>
        <div class="table-wrap">
          <table class="data">
            <thead>
              <tr>
                <th scope="col">Session</th>
                <th scope="col">Course</th>
                <th scope="col">When</th>
                <th scope="col">Instructor</th>
                <th scope="col">Status</th>
              </tr>
            </thead>
            <tbody>${rows}</tbody>
          </table>
        </div>
      </section>`;
  }

  /* ---- Cancelling ------------------------------------------------------ */

  async function cancel(bookingId, button) {
    const item = (data.upcoming || []).find((b) => b.bookingId === bookingId);
    if (!item) return;

    // Cancelling emails the instructor and pulls the event off the student's
    // calendar, so it always asks first.
    const confirmed = await UI.confirmDialog({
      title: 'Release your seat?',
      subtitle: item.event.title,
      message: `This gives up your place in ${item.event.title} on ` +
               `${UI.fmtRange(item.event.startDateTime, item.event.endDateTime)}.`,
      detail: 'Your instructor is notified and the event is removed from your calendar. ' +
              'If the session fills up afterwards you may not get back in.',
      confirmLabel: 'Yes, cancel my seat',
      cancelLabel: 'Keep my seat',
      danger: true
    });
    if (!confirmed) return;

    UI.setBusy(button, true, 'Cancelling…');

    try {
      const result = await Api.cancelBooking(bookingId);
      if (result.alreadyCancelled) {
        UI.toast('That booking was already cancelled.', 'info');
      } else {
        UI.toast('Your seat has been released.', 'success');
      }
      await load();
    } catch (e) {
      UI.setBusy(button, false);
      if (e && e.code === 'UNAUTHENTICATED') {
        UI.toast('Your sign-in expired. Please sign in again.', 'warning');
        Auth.promptSignIn();
        return;
      }
      UI.toast((e && e.message) || 'Could not cancel that booking.', 'error', 8000);
    }
  }

  /* ---- Wiring ---------------------------------------------------------- */

  document.addEventListener('DOMContentLoaded', () => {
    UI.initChrome();

    content.addEventListener('click', (e) => {
      const button = e.target.closest('[data-cancel]');
      if (button) cancel(button.dataset.cancel, button);
    });

    let lastSignedIn = null;
    Auth.onChange((snapshot) => {
      // Only reload when the signed-in state actually flips, not on every
      // repaint of the header chip.
      if (snapshot.signedIn !== lastSignedIn) {
        lastSignedIn = snapshot.signedIn;
        load();
      }
    });

    Auth.init();
  });
})();
