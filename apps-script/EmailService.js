/**
 * EmailService.js - Rice-branded HTML notification emails.
 *
 * These are *in addition to* the invitation/cancellation emails Google Calendar
 * sends by itself when guests are added or removed. Because of that, every send
 * here is best-effort: a mail failure (most likely the consumer-Gmail daily
 * recipient cap) must never roll back a booking that already succeeded.
 *
 * MailApp is used rather than GmailApp: it sends the same HTML mail as the
 * deploying account but needs only the narrow script.send_mail scope instead of
 * full mailbox access.
 */

var RICE_BLUE = '#00205B';
var RICE_GRAY = '#7C7E7F';
var RICE_LIGHT = '#E0E2E6';

function fromName_() {
  return getProp_(PROP_KEYS.FROM_NAME) || DEFAULT_FROM_NAME;
}

function siteUrl_() {
  return getProp_(PROP_KEYS.SITE_URL) || '';
}

/**
 * Best-effort send. Returns true on success, false on failure (logged).
 */
function sendMailSafe_(to, subject, htmlBody, plainBody) {
  try {
    MailApp.sendEmail({
      to: to,
      subject: subject,
      htmlBody: htmlBody,
      body: plainBody || htmlToPlain_(htmlBody),
      name: fromName_()
    });
    return true;
  } catch (e) {
    console.error('Email to ' + to + ' failed (' + subject + '): ' + e);
    return false;
  }
}

/**
 * Guard against burning the daily quota mid-operation. Returns true if there is
 * room for `needed` more recipients.
 */
function hasMailQuota_(needed) {
  try {
    var remaining = MailApp.getRemainingDailyQuota();
    if (remaining < needed) {
      console.warn('Skipping custom email: remaining quota ' + remaining + ' < needed ' + needed +
        '. Google Calendar notifications are unaffected.');
      return false;
    }
    return true;
  } catch (e) {
    // If the quota check itself fails, try to send anyway.
    return true;
  }
}

function htmlToPlain_(html) {
  return String(html)
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|tr|h1|h2|h3|div)>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&#39;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/**
 * Shared shell: Rice-blue header bar, white body, muted footer. Table-based
 * layout because email clients are not browsers.
 */
function emailShell_(opts) {
  var accent = opts.accent || RICE_BLUE;
  var cta = '';
  if (opts.ctaUrl && opts.ctaLabel) {
    cta =
      '<tr><td style="padding:8px 32px 28px 32px;">' +
        '<a href="' + escapeHtml_(opts.ctaUrl) + '" ' +
           'style="display:inline-block;background:' + accent + ';color:#ffffff;' +
           'text-decoration:none;font-weight:600;font-size:15px;padding:12px 22px;' +
           'border-radius:4px;">' + escapeHtml_(opts.ctaLabel) + '</a>' +
      '</td></tr>';
  }

  return '' +
  '<!doctype html><html><body style="margin:0;padding:0;background:#f4f5f7;">' +
  '<table role="presentation" width="100%" cellpadding="0" cellspacing="0" ' +
         'style="background:#f4f5f7;padding:24px 12px;">' +
    '<tr><td align="center">' +
      '<table role="presentation" width="600" cellpadding="0" cellspacing="0" ' +
             'style="max-width:600px;width:100%;background:#ffffff;border-radius:6px;' +
             'overflow:hidden;border:1px solid ' + RICE_LIGHT + ';' +
             'font-family:Georgia,\'Times New Roman\',serif;">' +

        '<tr><td style="background:' + RICE_BLUE + ';padding:20px 32px;">' +
          '<div style="color:#ffffff;font-size:18px;font-weight:700;letter-spacing:.02em;">' +
            'EDES 210 &nbsp;&middot;&nbsp; BIOE 555' +
          '</div>' +
          '<div style="color:#ADC7DC;font-size:13px;margin-top:4px;' +
                      'font-family:Helvetica,Arial,sans-serif;">' +
            'Prototyping &amp; Fabrication Lab Sessions' +
          '</div>' +
        '</td></tr>' +

        '<tr><td style="height:4px;background:' + accent + ';font-size:0;line-height:0;">&nbsp;</td></tr>' +

        '<tr><td style="padding:28px 32px 8px 32px;">' +
          '<h1 style="margin:0 0 12px 0;font-size:21px;color:' + RICE_BLUE + ';">' +
            escapeHtml_(opts.heading) + '</h1>' +
          '<p style="margin:0;font-size:15px;line-height:1.6;color:#333;' +
                     'font-family:Helvetica,Arial,sans-serif;">' +
            opts.intro +
          '</p>' +
        '</td></tr>' +

        '<tr><td style="padding:20px 32px 4px 32px;">' + opts.detailsTable + '</td></tr>' +

        (opts.note
          ? '<tr><td style="padding:4px 32px 8px 32px;">' +
              '<p style="margin:0;font-size:13px;line-height:1.6;color:' + RICE_GRAY + ';' +
                         'font-family:Helvetica,Arial,sans-serif;">' + opts.note + '</p>' +
            '</td></tr>'
          : '') +

        cta +

        '<tr><td style="background:#fafbfc;border-top:1px solid ' + RICE_LIGHT + ';' +
                        'padding:16px 32px;">' +
          '<p style="margin:0;font-size:12px;line-height:1.6;color:' + RICE_GRAY + ';' +
                     'font-family:Helvetica,Arial,sans-serif;">' +
            'Rice University &middot; Oshman Engineering Design Kitchen<br>' +
            'This is an automated message from the lab session booking system. ' +
            'You will also receive a separate Google Calendar notification.' +
          '</p>' +
        '</td></tr>' +

      '</table>' +
    '</td></tr>' +
  '</table></body></html>';
}

/** Two-column detail table used inside the shell. */
function detailsTable_(rows) {
  var body = rows.filter(function (r) { return r[1]; }).map(function (r) {
    return '<tr>' +
      '<td style="padding:7px 14px 7px 0;font-size:13px;color:' + RICE_GRAY + ';' +
                 'font-family:Helvetica,Arial,sans-serif;white-space:nowrap;' +
                 'vertical-align:top;text-transform:uppercase;letter-spacing:.04em;">' +
        escapeHtml_(r[0]) +
      '</td>' +
      '<td style="padding:7px 0;font-size:15px;color:#1a1a1a;' +
                 'font-family:Helvetica,Arial,sans-serif;vertical-align:top;">' +
        escapeHtml_(r[1]) +
      '</td>' +
    '</tr>';
  }).join('');

  return '<table role="presentation" cellpadding="0" cellspacing="0" width="100%" ' +
         'style="border-top:1px solid ' + RICE_LIGHT + ';border-bottom:1px solid ' + RICE_LIGHT + ';">' +
         body + '</table>';
}

function eventDetailRows_(event) {
  return [
    ['Session', event.title],
    ['Course', event.courseId],
    ['Type', event.sessionType],
    ['When', formatRange_(event.startDateTime, event.endDateTime)],
    ['Location', event.location],
    ['Instructor', event.teacherName || event.teacherEmail]
  ];
}

/* ------------------------------------------------------------------ *
 * Booking confirmed
 * ------------------------------------------------------------------ */

function sendBookingConfirmation_(event, student) {
  if (!hasMailQuota_(2)) return;

  var when = formatRange_(event.startDateTime, event.endDateTime);
  var site = siteUrl_();

  // To the student.
  sendMailSafe_(
    student.email,
    'Confirmed: ' + event.title + ' (' + when + ')',
    emailShell_({
      heading: 'Your seat is confirmed',
      intro: 'Hi ' + escapeHtml_(firstName_(student.name)) + ', you are booked into the following ' +
             'session. A Google Calendar invitation is on its way separately - accept it to ' +
             'get the reminder on your calendar.',
      detailsTable: detailsTable_(eventDetailRows_(event)),
      note: event.description ? '<strong>Session notes:</strong> ' + escapeHtml_(event.description) : '',
      ctaUrl: site ? site + 'my-bookings.html' : '',
      ctaLabel: site ? 'View my bookings' : '',
      accent: '#359245'
    })
  );

  // To the instructor.
  sendMailSafe_(
    event.teacherEmail,
    'New booking: ' + student.name + ' - ' + event.title,
    emailShell_({
      heading: 'New booking for your session',
      intro: escapeHtml_(student.name) + ' (' + escapeHtml_(student.email) + ') just booked a seat ' +
             'in your session. They have been added as a guest on the calendar event.',
      detailsTable: detailsTable_(
        eventDetailRows_(event).concat([
          ['Student', student.name + ' <' + student.email + '>'],
          ['Seats left', String(event.seatsRemaining) + ' of ' + String(event.capacity)]
        ])
      ),
      ctaUrl: site ? site + 'admin.html' : '',
      ctaLabel: site ? 'Open the roster' : ''
    })
  );
}

/* ------------------------------------------------------------------ *
 * Student cancelled their own booking
 * ------------------------------------------------------------------ */

function sendBookingCancellation_(event, student) {
  if (!hasMailQuota_(2)) return;

  var when = formatRange_(event.startDateTime, event.endDateTime);
  var site = siteUrl_();

  sendMailSafe_(
    student.email,
    'Cancelled: ' + event.title + ' (' + when + ')',
    emailShell_({
      heading: 'Your booking is cancelled',
      intro: 'Hi ' + escapeHtml_(firstName_(student.name)) + ', your seat in the session below has ' +
             'been released and you have been removed from the calendar event.',
      detailsTable: detailsTable_(eventDetailRows_(event)),
      note: 'Changed your mind? If seats are still open you can book again from the site.',
      ctaUrl: site ? site + 'book.html' : '',
      ctaLabel: site ? 'Browse open sessions' : '',
      accent: '#E9A139'
    })
  );

  sendMailSafe_(
    event.teacherEmail,
    'Booking cancelled: ' + student.name + ' - ' + event.title,
    emailShell_({
      heading: 'A student cancelled',
      intro: escapeHtml_(student.name) + ' (' + escapeHtml_(student.email) + ') cancelled their seat. ' +
             'The seat is back in the pool and they have been removed from the calendar event.',
      detailsTable: detailsTable_(
        eventDetailRows_(event).concat([
          ['Student', student.name + ' <' + student.email + '>'],
          ['Seats left', String(event.seatsRemaining) + ' of ' + String(event.capacity)]
        ])
      ),
      ctaUrl: site ? site + 'admin.html' : '',
      ctaLabel: site ? 'Open the roster' : '',
      accent: '#E9A139'
    })
  );
}

/* ------------------------------------------------------------------ *
 * Teacher cancelled the whole session
 * ------------------------------------------------------------------ */

/**
 * @param {Object} event
 * @param {Array<{email:string,name:string}>} students everyone who was booked
 * @param {string} cancelledBy email of the teacher who cancelled
 */
function sendEventCancelledEmails_(event, students, cancelledBy) {
  var recipients = students.length + 1;
  if (!hasMailQuota_(recipients)) return;

  var when = formatRange_(event.startDateTime, event.endDateTime);
  var site = siteUrl_();
  var rows = detailsTable_(eventDetailRows_(event));

  students.forEach(function (student) {
    sendMailSafe_(
      student.email,
      'Session cancelled: ' + event.title + ' (' + when + ')',
      emailShell_({
        heading: 'This session has been cancelled',
        intro: 'Hi ' + escapeHtml_(firstName_(student.name)) + ', the session below has been ' +
               'cancelled by the instructor. You do not need to do anything - the calendar event ' +
               'has been removed for you.',
        detailsTable: rows,
        note: 'Please check the booking site for other available sessions.',
        ctaUrl: site ? site + 'book.html' : '',
        ctaLabel: site ? 'Find another session' : '',
        accent: '#C04829'
      })
    );
  });

  sendMailSafe_(
    event.teacherEmail,
    'Your session was cancelled: ' + event.title,
    emailShell_({
      heading: 'Session cancelled',
      intro: 'The session below was cancelled by ' + escapeHtml_(cancelledBy) + '. ' +
             String(students.length) + ' booked student(s) were notified and the calendar ' +
             'event was deleted.',
      detailsTable: rows,
      accent: '#C04829'
    })
  );
}

/* ------------------------------------------------------------------ *
 * New session created
 * ------------------------------------------------------------------ */

function sendEventCreatedEmail_(event, createdBy) {
  if (!hasMailQuota_(1)) return;
  var site = siteUrl_();

  sendMailSafe_(
    event.teacherEmail,
    'Session published: ' + event.title,
    emailShell_({
      heading: 'Your session is live',
      intro: (normalizeEmail_(createdBy) === normalizeEmail_(event.teacherEmail)
        ? 'Your session is now published and open for booking.'
        : escapeHtml_(createdBy) + ' scheduled you to lead the session below. It is now open ' +
          'for booking.'),
      detailsTable: detailsTable_(
        eventDetailRows_(event).concat([['Capacity', String(event.capacity) + ' seats']])
      ),
      note: 'You have been added as a guest on the calendar event. Students will appear as ' +
            'additional guests as they book.',
      ctaUrl: site ? site + 'admin.html' : '',
      ctaLabel: site ? 'Manage sessions' : ''
    })
  );
}

function firstName_(fullName) {
  var s = trimStr_(fullName);
  if (!s) return 'there';
  return s.split(/\s+/)[0];
}
