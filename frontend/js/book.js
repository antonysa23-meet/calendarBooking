/* ==========================================================================
   book.js — browse open sessions and take a seat.
   ========================================================================== */

(function () {
  const els = {
    events: document.querySelector('#events'),
    count: document.querySelector('#result-count'),
    course: document.querySelector('#filter-course'),
    search: document.querySelector('#filter-search'),
    availability: document.querySelector('#filter-availability'),
    refresh: document.querySelector('#refresh-btn'),
    signedOutNote: document.querySelector('#signed-out-note')
  };

  let allEvents = [];
  let bookedEventIds = new Set();
  let loading = false;
  let hasLoaded = false;

  /* ---- Data ------------------------------------------------------------ */

  async function loadCourses() {
    try {
      const data = await Api.listCourses();
      (data.courses || []).forEach((course) => {
        const option = document.createElement('option');
        option.value = course.courseId;
        option.textContent = course.courseName || course.courseId;
        els.course.appendChild(option);
      });
    } catch (e) {
      // A missing course filter is survivable; the list itself still loads.
      console.warn('Could not load courses:', e);
    }
  }

  /** Which sessions this user already holds a seat in, for the badge. */
  async function loadMyBookings() {
    bookedEventIds = new Set();
    if (!Auth.getToken()) return;
    try {
      const data = await Api.listMyBookings();
      (data.upcoming || []).forEach((item) => bookedEventIds.add(item.event.eventId));
    } catch (e) {
      console.warn('Could not load your bookings:', e);
    }
  }

  async function loadEvents({ quiet = false } = {}) {
    if (loading) return;
    loading = true;
    if (!quiet) els.events.innerHTML = UI.skeletons(6);

    try {
      const [data] = await Promise.all([Api.listEvents({}), loadMyBookings()]);
      allEvents = data.events || [];
      hasLoaded = true;
      render();
    } catch (e) {
      els.events.innerHTML = UI.errorPanel(e);
      els.count.textContent = '';
    } finally {
      loading = false;
    }
  }

  /* ---- Rendering ------------------------------------------------------- */

  function applyFilters() {
    const course = els.course.value;
    const query = els.search.value.trim().toLowerCase();
    const openOnly = els.availability.value === 'open';

    return allEvents.filter((event) => {
      if (course && event.courseId !== course) return false;
      if (openOnly && event.seatsRemaining <= 0 && !bookedEventIds.has(event.eventId)) return false;
      if (query) {
        const haystack = [
          event.title, event.sessionType, event.location,
          event.teacherName, event.description, event.courseId
        ].join(' ').toLowerCase();
        if (!haystack.includes(query)) return false;
      }
      return true;
    });
  }

  function actionFor(event) {
    if (bookedEventIds.has(event.eventId)) {
      return '<a class="btn btn-secondary btn-sm" href="my-bookings.html">Manage booking</a>';
    }
    if (event.seatsRemaining <= 0) {
      return '<button class="btn btn-sm" type="button" disabled>Full</button>';
    }
    return `<button class="btn btn-sm" type="button" data-book="${UI.esc(event.eventId)}">Book a seat</button>`;
  }

  function render() {
    const filtered = applyFilters();

    if (!allEvents.length) {
      els.events.innerHTML = UI.emptyState(
        'No sessions are open right now',
        'Nothing has been published yet, or every session has already happened. Check back soon.'
      );
      els.count.textContent = '';
      return;
    }

    if (!filtered.length) {
      els.events.innerHTML = UI.emptyState(
        'Nothing matches those filters',
        'Try clearing the search box, or switch Availability to "All sessions".'
      );
      els.count.textContent = `0 of ${allEvents.length} sessions shown`;
      return;
    }

    els.count.textContent = filtered.length === allEvents.length
      ? `${filtered.length} session${filtered.length === 1 ? '' : 's'}`
      : `${filtered.length} of ${allEvents.length} sessions shown`;

    els.events.innerHTML = `<div class="card-grid">${
      filtered.map((event) => UI.sessionCard(event, {
        booked: bookedEventIds.has(event.eventId),
        actionHtml: actionFor(event)
      })).join('')
    }</div>`;

    highlightDeepLink();
  }

  /** Home page links here with #eventId; nudge that card into view. */
  function highlightDeepLink() {
    const wanted = decodeURIComponent((location.hash || '').replace('#', ''));
    if (!wanted) return;
    const button = els.events.querySelector(`[data-book="${CSS.escape(wanted)}"]`);
    const card = button && button.closest('.session-card');
    if (!card) return;
    card.scrollIntoView({ behavior: 'smooth', block: 'center' });
    card.style.outline = '2px solid var(--rice-blue-400)';
    card.style.outlineOffset = '3px';
    setTimeout(() => { card.style.outline = ''; }, 2600);
  }

  function renderSignedOutNote(signedIn) {
    if (signedIn) {
      els.signedOutNote.innerHTML = '';
      return;
    }
    els.signedOutNote.innerHTML = `
      <div class="alert alert-info">
        <div>
          <strong>Sign in to book</strong>
          You can browse without signing in, but taking a seat needs your
          <strong>@rice.edu</strong> Google account. Use the Sign in button in the header.
        </div>
      </div>`;
  }

  /* ---- Booking --------------------------------------------------------- */

  async function book(eventId, button) {
    if (!Auth.getToken()) {
      UI.toast('Please sign in with your Rice account first.', 'warning');
      Auth.promptSignIn();
      return;
    }

    UI.setBusy(button, true, 'Booking…');

    try {
      const result = await Api.bookSlot(eventId);
      bookedEventIds.add(eventId);

      UI.toast(
        `You are booked into ${result.event.title}. Check your email for the calendar invitation.`,
        'success',
        8000
      );

      if (result.calendarUpdated === false) {
        UI.toast(
          'Your seat is saved, but the calendar invitation could not be sent. Let your ' +
          'instructor know so they can add you manually.',
          'warning',
          12000
        );
      }

      await loadEvents({ quiet: true });
    } catch (e) {
      UI.setBusy(button, false);
      handleBookingError(e, eventId);
    }
  }

  function handleBookingError(error, eventId) {
    const code = error && error.code;

    if (code === 'EVENT_FULL') {
      UI.toast(error.message, 'error', 8000);
      loadEvents({ quiet: true });        // someone beat them to the last seat
      return;
    }
    if (code === 'ALREADY_BOOKED') {
      bookedEventIds.add(eventId);
      UI.toast(error.message, 'warning');
      render();
      return;
    }
    if (code === 'EVENT_CANCELLED' || code === 'EVENT_PAST' || code === 'NOT_FOUND') {
      UI.toast(error.message, 'error', 8000);
      loadEvents({ quiet: true });
      return;
    }
    if (code === 'UNAUTHENTICATED') {
      UI.toast('Your sign-in expired. Please sign in again.', 'warning');
      Auth.promptSignIn();
      return;
    }
    UI.toast((error && error.message) || 'Could not book that seat.', 'error', 8000);
  }

  /* ---- Wiring ---------------------------------------------------------- */

  function debounce(fn, ms) {
    let timer;
    return (...args) => {
      clearTimeout(timer);
      timer = setTimeout(() => fn(...args), ms);
    };
  }

  document.addEventListener('DOMContentLoaded', () => {
    UI.initChrome();

    els.events.addEventListener('click', (e) => {
      const button = e.target.closest('[data-book]');
      if (button) book(button.dataset.book, button);
    });

    els.course.addEventListener('change', render);
    els.availability.addEventListener('change', render);
    els.search.addEventListener('input', debounce(render, 180));
    els.refresh.addEventListener('click', () => loadEvents());

    // Re-check the "you are booked" badges whenever sign-in state changes.
    // Only the bookings are refetched here — the session list is already in
    // flight from the initial load and does not depend on who is signed in.
    Auth.onChange(async (snapshot) => {
      renderSignedOutNote(snapshot.signedIn);
      if (snapshot.signedIn && snapshot.resolved) await loadMyBookings();
      else bookedEventIds = new Set();
      if (hasLoaded) render();
    });

    renderSignedOutNote(false);
    Auth.init();
    loadCourses();
    loadEvents();
  });
})();
