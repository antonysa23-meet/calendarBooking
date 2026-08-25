/* ==========================================================================
   home.js - landing page: chrome, sign-in, and the next few open sessions.
   ========================================================================== */

(function () {
  const MAX_PREVIEW = 3;
  const target = document.querySelector('#upcoming');

  async function loadUpcoming() {
    target.innerHTML = UI.skeletons(MAX_PREVIEW, 'Loading upcoming sessions…');

    try {
      const data = await Api.listEvents({});
      const open = (data.events || []).filter((e) => e.seatsRemaining > 0);
      const shown = (open.length ? open : data.events || []).slice(0, MAX_PREVIEW);

      if (!shown.length) {
        target.innerHTML = UI.emptyState(
          'No sessions scheduled yet',
          'Once an instructor publishes a training or equipment session, it will appear here.',
          '<a class="btn btn-secondary btn-sm" href="book.html">Check the full list</a>'
        );
        return;
      }

      target.innerHTML = `<div class="card-grid">${
        shown.map((event) => UI.sessionCard(event, {
          actionHtml: event.seatsRemaining > 0
            ? `<a class="btn btn-sm" href="book.html#${encodeURIComponent(event.eventId)}">Book this</a>`
            : '<span class="small muted">Fully booked</span>'
        })).join('')
      }</div>`;
    } catch (e) {
      target.innerHTML = UI.errorPanel(e);
    }
  }

  document.addEventListener('DOMContentLoaded', () => {
    UI.initChrome();
    Auth.init();
    loadUpcoming();
  });
})();
