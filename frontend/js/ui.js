/* ==========================================================================
   ui.js - shared DOM helpers: escaping, formatting, toasts, modals, icons.
   Loaded on every page before the page-specific script.
   ========================================================================== */

const UI = (function () {

  /* ---- Escaping ------------------------------------------------------- */

  /**
   * Everything user-supplied (session titles, student names, descriptions)
   * goes through this before it is interpolated into innerHTML.
   */
  function esc(value) {
    return String(value === null || value === undefined ? '' : value)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  /* ---- Dates ---------------------------------------------------------- */

  function tz() {
    return (window.APP_CONFIG && window.APP_CONFIG.DISPLAY_TIMEZONE) || 'America/Chicago';
  }

  /** e.g. "Mon, Sep 14, 2026" */
  function fmtDate(iso) {
    const d = new Date(iso);
    if (isNaN(d)) return '';
    return d.toLocaleDateString('en-US', {
      timeZone: tz(), weekday: 'short', month: 'short', day: 'numeric', year: 'numeric'
    });
  }

  /** e.g. "2:00 PM" */
  function fmtTime(iso) {
    const d = new Date(iso);
    if (isNaN(d)) return '';
    return d.toLocaleTimeString('en-US', {
      timeZone: tz(), hour: 'numeric', minute: '2-digit'
    });
  }

  /** e.g. "Mon, Sep 14, 2026 · 2:00 – 3:30 PM CDT" */
  function fmtRange(startIso, endIso) {
    const start = new Date(startIso);
    if (isNaN(start)) return '';
    const zone = new Intl.DateTimeFormat('en-US', { timeZone: tz(), timeZoneName: 'short' })
      .formatToParts(start).find(p => p.type === 'timeZoneName');
    const suffix = zone ? ' ' + zone.value : '';
    if (!endIso) return `${fmtDate(startIso)} · ${fmtTime(startIso)}${suffix}`;
    return `${fmtDate(startIso)} · ${fmtTime(startIso)} – ${fmtTime(endIso)}${suffix}`;
  }

  /** "in 3 days", "tomorrow", "today" - for at-a-glance urgency. */
  function relativeDay(iso) {
    const d = new Date(iso);
    if (isNaN(d)) return '';
    const dayMs = 86400000;
    const startOf = (date) => {
      const s = new Date(date.toLocaleString('en-US', { timeZone: tz() }));
      s.setHours(0, 0, 0, 0);
      return s.getTime();
    };
    const days = Math.round((startOf(d) - startOf(new Date())) / dayMs);
    if (days === 0) return 'today';
    if (days === 1) return 'tomorrow';
    if (days === -1) return 'yesterday';
    if (days > 1 && days <= 14) return `in ${days} days`;
    if (days < -1) return `${Math.abs(days)} days ago`;
    return '';
  }

  /**
   * Turn a date + time from form inputs into a UTC ISO string, interpreting
   * them in the display timezone rather than the browser's.
   *
   * Without this, a teacher travelling in another timezone would schedule a
   * 2pm session at 2pm *their* time. Two passes converge across DST edges.
   */
  function localInputToIso(dateStr, timeStr) {
    if (!dateStr || !timeStr) return '';
    const zone = tz();

    // Treat the wall-clock reading as if it were UTC, then shift it by however
    // far the target zone sits from UTC.
    const naive = new Date(`${dateStr}T${timeStr}:00Z`);
    if (isNaN(naive)) return '';

    let instant = new Date(naive.getTime() - zoneOffsetMs(naive, zone));
    // Refine once with the offset at the approximated instant, which is what
    // makes this correct on the two DST changeover days.
    instant = new Date(naive.getTime() - zoneOffsetMs(instant, zone));
    return instant.toISOString();
  }

  /** How far the named zone is from UTC at a given instant, in ms. */
  function zoneOffsetMs(date, zone) {
    const parts = new Intl.DateTimeFormat('en-US', {
      timeZone: zone, hour12: false,
      year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', second: '2-digit'
    }).formatToParts(date).reduce((acc, p) => (acc[p.type] = p.value, acc), {});

    const asUtc = Date.UTC(
      Number(parts.year), Number(parts.month) - 1, Number(parts.day),
      Number(parts.hour) % 24, Number(parts.minute), Number(parts.second)
    );
    return asUtc - date.getTime();
  }

  /* ---- Icons (inline so there are no external requests) ---------------- */

  const ICONS = {
    calendar: '<path d="M8 2v3M16 2v3M3.5 9h17M5 5h14a1.5 1.5 0 0 1 1.5 1.5v13A1.5 1.5 0 0 1 19 21H5a1.5 1.5 0 0 1-1.5-1.5v-13A1.5 1.5 0 0 1 5 5z"/>',
    pin: '<path d="M12 21s7-5.686 7-11a7 7 0 1 0-14 0c0 5.314 7 11 7 11z"/><circle cx="12" cy="10" r="2.5"/>',
    user: '<circle cx="12" cy="8" r="3.5"/><path d="M4.5 20a7.5 7.5 0 0 1 15 0"/>',
    tag: '<path d="M3 12V4.5A1.5 1.5 0 0 1 4.5 3H12l9 9-8 8-9-9z"/><circle cx="7.5" cy="7.5" r="1.25"/>',
    seats: '<path d="M4 18v-6a2 2 0 0 1 2-2h12a2 2 0 0 1 2 2v6M7 10V6.5A2.5 2.5 0 0 1 9.5 4h5A2.5 2.5 0 0 1 17 6.5V10M4 18h16"/>',
    menu: '<path d="M4 7h16M4 12h16M4 17h16"/>'
  };

  function icon(name) {
    const path = ICONS[name];
    if (!path) return '';
    return `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6"
      stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${path}</svg>`;
  }

  /* ---- Toasts --------------------------------------------------------- */

  function toastStack() {
    let stack = document.querySelector('.toast-stack');
    if (!stack) {
      stack = document.createElement('div');
      stack.className = 'toast-stack';
      stack.setAttribute('role', 'status');
      stack.setAttribute('aria-live', 'polite');
      document.body.appendChild(stack);
    }
    return stack;
  }

  /**
   * @param {string} message
   * @param {'success'|'error'|'warning'|'info'} [type]
   */
  function toast(message, type = 'info', timeoutMs = 6000) {
    const el = document.createElement('div');
    el.className = `toast toast-${type}`;
    el.innerHTML = `<div>${esc(message)}</div>
      <button class="toast-close" type="button" aria-label="Dismiss">&times;</button>`;

    const remove = () => {
      el.remove();
    };
    el.querySelector('.toast-close').addEventListener('click', remove);
    toastStack().appendChild(el);
    if (timeoutMs) setTimeout(remove, timeoutMs);
    return el;
  }

  /* ---- Buttons -------------------------------------------------------- */

  /** Disable + spinner while an async action runs, restoring the label after. */
  function setBusy(button, busy, busyLabel) {
    if (!button) return;
    if (busy) {
      button.dataset.label = button.dataset.label || button.textContent;
      button.classList.add('is-loading');
      button.disabled = true;
      if (busyLabel) button.textContent = busyLabel;
    } else {
      button.classList.remove('is-loading');
      button.disabled = false;
      if (button.dataset.label) button.textContent = button.dataset.label;
    }
  }

  /* ---- Modal ---------------------------------------------------------- */

  /**
   * Open a modal. Returns a handle with close(). Focus is trapped loosely:
   * focus moves in, Escape and backdrop clicks close it, and focus returns to
   * whatever opened it.
   *
   * @param {{title:string, subtitle?:string, body:string, footer?:string,
   *          onMount?:function(HTMLElement, function():void)}} opts
   */
  function modal(opts) {
    const opener = document.activeElement;
    const backdrop = document.createElement('div');
    backdrop.className = 'modal-backdrop';
    backdrop.innerHTML = `
      <div class="modal" role="dialog" aria-modal="true" aria-label="${esc(opts.title)}">
        <div class="modal-head">
          <div>
            <h3>${esc(opts.title)}</h3>
            ${opts.subtitle ? `<p class="modal-sub">${esc(opts.subtitle)}</p>` : ''}
          </div>
          <button class="modal-close" type="button" aria-label="Close">&times;</button>
        </div>
        <div class="modal-body">${opts.body || ''}</div>
        ${opts.footer ? `<div class="modal-foot">${opts.footer}</div>` : ''}
      </div>`;

    function close() {
      document.removeEventListener('keydown', onKey);
      backdrop.remove();
      if (opener && opener.focus) opener.focus();
    }

    function onKey(e) {
      if (e.key === 'Escape') close();
    }

    backdrop.addEventListener('click', (e) => {
      if (e.target === backdrop) close();
    });
    backdrop.querySelector('.modal-close').addEventListener('click', close);
    document.addEventListener('keydown', onKey);

    document.body.appendChild(backdrop);
    if (opts.onMount) opts.onMount(backdrop.querySelector('.modal'), close);
    const focusTarget = backdrop.querySelector('[data-autofocus]') || backdrop.querySelector('.modal-close');
    if (focusTarget) focusTarget.focus();

    return { close, root: backdrop };
  }

  /**
   * Confirmation dialog. Resolves true if the user confirms.
   * Used before anything that sends real email to real people.
   */
  function confirmDialog(opts) {
    return new Promise((resolve) => {
      let settled = false;
      const handle = modal({
        title: opts.title,
        subtitle: opts.subtitle,
        body: `<p>${esc(opts.message)}</p>${opts.detail ? `<p class="small muted">${esc(opts.detail)}</p>` : ''}`,
        footer: `
          <button class="btn btn-secondary" type="button" data-act="cancel">${esc(opts.cancelLabel || 'Keep it')}</button>
          <button class="btn ${opts.danger ? 'btn-danger' : ''}" type="button" data-act="confirm" data-autofocus>${esc(opts.confirmLabel || 'Confirm')}</button>`,
        onMount(root, close) {
          root.querySelector('[data-act="cancel"]').addEventListener('click', () => {
            settled = true; close(); resolve(false);
          });
          root.querySelector('[data-act="confirm"]').addEventListener('click', () => {
            settled = true; close(); resolve(true);
          });
        }
      });
      // Dismissing via Escape or the backdrop counts as "no".
      const observer = new MutationObserver(() => {
        if (!document.body.contains(handle.root)) {
          observer.disconnect();
          if (!settled) resolve(false);
        }
      });
      observer.observe(document.body, { childList: true });
    });
  }

  /* ---- Rendering helpers ---------------------------------------------- */

  function emptyState(title, message, actionHtml) {
    return `<div class="empty-state">
      <h3>${esc(title)}</h3>
      <p>${esc(message)}</p>
      ${actionHtml ? `<p style="margin-top:1rem">${actionHtml}</p>` : ''}
    </div>`;
  }

  function skeletons(count = 3) {
    return `<div class="skeleton-grid">${'<div class="skeleton-card"></div>'.repeat(count)}</div>`;
  }

  function errorPanel(error) {
    const message = (error && error.message) || 'Something went wrong.';
    return `<div class="alert alert-danger"><div><strong>We hit a problem</strong>${esc(message)}</div></div>`;
  }

  /** Seat-count badge + meter shared by the book and admin views. */
  function seatBadge(event) {
    const threshold = (window.APP_CONFIG && window.APP_CONFIG.LOW_SEATS_THRESHOLD) || 3;
    if (event.status === 'CANCELLED') return { cls: 'badge-cancelled', label: 'Cancelled', level: 'full' };
    if (event.isPast) return { cls: 'badge-past', label: 'Past', level: 'full' };
    if (event.seatsRemaining <= 0) return { cls: 'badge-full', label: 'Full', level: 'full' };
    if (event.seatsRemaining <= threshold) {
      return { cls: 'badge-few', label: `${event.seatsRemaining} left`, level: 'few' };
    }
    return { cls: 'badge-open', label: `${event.seatsRemaining} seats open`, level: 'open' };
  }

  /**
   * The session card used on the home page and the booking grid.
   *
   * @param {Object} event an event DTO from the backend
   * @param {{actionHtml?:string, booked?:boolean}} [opts]
   */
  function sessionCard(event, opts = {}) {
    const seats = seatBadge(event);
    const pct = event.capacity > 0
      ? Math.min(100, Math.round((event.bookedCount / event.capacity) * 100))
      : 100;
    const soon = relativeDay(event.startDateTime);

    const classes = ['session-card'];
    if (opts.booked) classes.push('is-booked');
    else if (event.status === 'CANCELLED') classes.push('is-cancelled');
    else if (event.seatsRemaining <= 0) classes.push('is-full');

    const row = (iconName, text, extra = '') => text
      ? `<div class="session-meta-row">${icon(iconName)}<span>${esc(text)}${extra}</span></div>`
      : '';

    return `
      <article class="${classes.join(' ')}">
        <div class="session-card-head">
          <span class="badge badge-course" data-course="${esc(event.courseId)}">${esc(event.courseId)}</span>
          ${opts.booked ? '<span class="badge badge-booked">You are booked</span>' : ''}
        </div>

        <div class="session-card-body">
          ${event.sessionType ? `<span class="session-type">${esc(event.sessionType)}</span>` : ''}
          <h3 class="session-title">${esc(event.title)}</h3>
          <div class="session-meta">
            ${row('calendar', fmtRange(event.startDateTime, event.endDateTime),
                  soon ? ` <span class="muted">(${esc(soon)})</span>` : '')}
            ${row('pin', event.location)}
            ${row('user', event.teacherName || event.teacherEmail)}
          </div>
          ${event.description
            ? `<p class="session-desc">${esc(event.description)}</p>`
            : ''}
          <div class="seat-meter" role="img"
               aria-label="${event.bookedCount} of ${event.capacity} seats taken">
            <div class="seat-meter-fill" data-level="${seats.level}" style="width:${pct}%"></div>
          </div>
        </div>

        <div class="session-card-foot">
          <span class="seats">
            <span class="badge ${seats.cls}">${esc(seats.label)}</span>
            <span>&nbsp;of ${event.capacity}</span>
          </span>
          ${opts.actionHtml || ''}
        </div>
      </article>`;
  }

  /* ---- Page furniture -------------------------------------------------- */

  /** Marks the current nav link and wires the mobile menu toggle. */
  function initChrome() {
    const here = (location.pathname.split('/').pop() || 'index.html').toLowerCase();
    document.querySelectorAll('.site-nav a.nav-link').forEach((link) => {
      const target = (link.getAttribute('href') || '').toLowerCase();
      if (target === here || (here === '' && target === 'index.html')) {
        link.setAttribute('aria-current', 'page');
      }
    });

    const toggle = document.querySelector('.nav-toggle');
    const nav = document.querySelector('.site-nav');
    if (toggle && nav) {
      toggle.innerHTML = icon('menu');
      toggle.addEventListener('click', () => {
        const open = nav.classList.toggle('is-open');
        toggle.setAttribute('aria-expanded', String(open));
      });
    }

    const year = document.querySelector('[data-year]');
    if (year) year.textContent = String(new Date().getFullYear());
  }

  return {
    esc, icon,
    fmtDate, fmtTime, fmtRange, relativeDay, localInputToIso,
    toast, setBusy, modal, confirmDialog,
    emptyState, skeletons, errorPanel, seatBadge, sessionCard,
    initChrome
  };
})();

window.UI = UI;
