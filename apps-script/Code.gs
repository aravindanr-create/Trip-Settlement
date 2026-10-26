/**
 * Trip Settlement – email sender (Google Apps Script web app)
 *
 * The Trip Settlement app calls this script after "Send for approval".
 * It sends the settlement email from the Google account that deploys it.
 *
 * Safety:
 *  - Only works for people signed in to the Trip Settlement app
 *    (the script checks their login with Supabase).
 *  - Emails go ONLY to the 4 recipients saved in the app's
 *    "Email report to" list. Any other address sent to it is ignored.
 */

const SUPABASE_URL = 'https://kcouuizatvepsebpfxpn.supabase.co';
const SUPABASE_KEY = 'sb_publishable_hYSJSYIQg-MUsdWhEpdzVg_vFsgYm5Q'; // publishable key – safe to keep here
const SENDER_NAME  = 'Aravindan R - Uddhava Logistics';

function doPost(e) {
  try {
    const body = JSON.parse(e.postData.contents);
    const token = String(body.token || '');
    if (!token) return reply_({ ok: false, error: 'Not signed in' });

    // 1. Check the person is signed in to the app
    const userRes = UrlFetchApp.fetch(SUPABASE_URL + '/auth/v1/user', {
      headers: { apikey: SUPABASE_KEY, Authorization: 'Bearer ' + token },
      muteHttpExceptions: true
    });
    if (userRes.getResponseCode() !== 200) return reply_({ ok: false, error: 'Login expired. Sign in again.' });
    const user = JSON.parse(userRes.getContentText());

    // 2. Read the saved recipients (never trust addresses sent by the page)
    const recRes = UrlFetchApp.fetch(SUPABASE_URL + '/rest/v1/ts_recipients?select=email&order=slot', {
      headers: { apikey: SUPABASE_KEY, Authorization: 'Bearer ' + token },
      muteHttpExceptions: true
    });
    if (recRes.getResponseCode() !== 200) return reply_({ ok: false, error: 'Could not read the recipient list' });
    const to = JSON.parse(recRes.getContentText())
      .map(function (r) { return String(r.email || '').trim(); })
      .filter(function (x) { return /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(x); });
    if (!to.length) return reply_({ ok: false, error: 'No recipient emails saved in the app' });

    // 3. Send
    MailApp.sendEmail({
      to: to.join(','),
      subject: String(body.subject || 'Trip Settlement').slice(0, 250),
      htmlBody: String(body.html || ''),
      name: SENDER_NAME,
      replyTo: user.email
    });
    return reply_({ ok: true, sentTo: to, quotaLeft: MailApp.getRemainingDailyQuota() });
  } catch (err) {
    return reply_({ ok: false, error: String(err && err.message || err) });
  }
}

/** Run this once from the editor to grant the "send email" permission. */
function authorize() {
  Logger.log('Emails left today: ' + MailApp.getRemainingDailyQuota());
}

function reply_(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj)).setMimeType(ContentService.MimeType.JSON);
}
