/**
 * Trip Settlement – email sender + Approve / Reject (Google Apps Script web app)
 *
 * doPost : the Trip Settlement app calls this to send the approval email
 *          (recipient 1 in "To", all others in "CC").
 * doGet  : the Approve / Reject buttons inside that email open this page.
 *          The approver confirms with their name (and remarks); the decision is
 *          saved in the app, and an approved settlement is emailed to Finance.
 *
 * Safety:
 *  - Sending needs a signed-in Trip Settlement user (checked with Supabase).
 *  - Emails go ONLY to the recipients saved in the app's Settings page.
 *  - Each approval email carries a long secret code. A decision is accepted only
 *    with that code, only once, and only while the settlement is Pending.
 *    Editing and resending a settlement replaces the code, so old emails stop working.
 */

const SUPABASE_URL  = 'https://kcouuizatvepsebpfxpn.supabase.co';
const SUPABASE_KEY  = 'sb_publishable_hYSJSYIQg-MUsdWhEpdzVg_vFsgYm5Q'; // publishable key – safe to keep here
const SENDER_NAME   = 'Aravindan R - Uddhava Logistics';
// Approved settlements are emailed to all of these (comma-separated)
const FINANCE_EMAIL = 'finance@aartycarriers.com,aravindan.r@aartycarriers.com';

/* ---------------- 1. Send the approval email (called by the app) ---------------- */
function doPost(e) {
  try {
    const body = JSON.parse(e.postData.contents);
    const token = String(body.token || '');
    if (!token) return reply_({ ok: false, error: 'Not signed in' });

    const userRes = UrlFetchApp.fetch(SUPABASE_URL + '/auth/v1/user', {
      headers: { apikey: SUPABASE_KEY, Authorization: 'Bearer ' + token },
      muteHttpExceptions: true
    });
    if (userRes.getResponseCode() !== 200) return reply_({ ok: false, error: 'Login expired. Sign in again.' });
    const user = JSON.parse(userRes.getContentText());

    const recRes = UrlFetchApp.fetch(SUPABASE_URL + '/rest/v1/ts_recipients?select=email&order=slot', {
      headers: { apikey: SUPABASE_KEY, Authorization: 'Bearer ' + token },
      muteHttpExceptions: true
    });
    if (recRes.getResponseCode() !== 200) return reply_({ ok: false, error: 'Could not read the recipient list' });
    const to = JSON.parse(recRes.getContentText())
      .map(function (r) { return String(r.email || '').trim(); })
      .filter(function (x) { return /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(x); });
    if (!to.length) return reply_({ ok: false, error: 'No recipient emails saved in the app' });

    MailApp.sendEmail({
      to: to[0],
      cc: to.slice(1).join(','),
      subject: String(body.subject || 'Trip Settlement').slice(0, 250),
      htmlBody: String(body.html || ''),
      name: SENDER_NAME,
      replyTo: user.email
    });
    return reply_({ ok: true, to: to[0], cc: to.slice(1), quotaLeft: MailApp.getRemainingDailyQuota() });
  } catch (err) {
    return reply_({ ok: false, error: String(err && err.message || err) });
  }
}

/* ---------------- 2. Approve / Reject page (opened from the email) ---------------- */
function doGet(e) {
  const p = (e && e.parameter) || {};
  const t = HtmlService.createTemplate(PAGE_HTML);
  t.id = String(p.id || '');
  t.code = String(p.t || '');
  t.action = p.a === 'reject' ? 'reject' : 'approve';
  let info = null;
  try { info = (t.id && t.code) ? rpc_('ts_decision_info', { p_id: t.id, p_token: t.code }) : null; } catch (err) { info = null; }
  t.info = info;
  let who = '';
  try { who = Session.getActiveUser().getEmail() || ''; } catch (err) { who = ''; }
  t.who = who;
  return t.evaluate()
    .setTitle('Trip Settlement – Approval')
    .addMetaTag('viewport', 'width=device-width, initial-scale=1');
}

/** Called from the approval page with google.script.run */
function decide(id, code, action, name, remarks) {
  const decision = action === 'reject' ? 'Rejected' : 'Approved';
  const res = rpc_('ts_decide', { p_id: id, p_token: code, p_decision: decision, p_by: String(name || ''), p_remarks: String(remarks || '') });
  if (!res) throw new Error('This approval link is no longer valid. The settlement may have been edited and resent – please use the latest email.');
  if (res.already) return { already: true, status: res.status, decided_by: res.decided_by, decided_at: res.decided_at };

  const owner = Session.getEffectiveUser().getEmail();
  const final = Number(res.net || 0) - Number(res.debit || 0);
  const banner = function (color, title) {
    return '<div style="font-family:Calibri,Arial,sans-serif;border:2px solid ' + color + ';border-radius:6px;padding:10px 14px;margin:0 0 14px">' +
      '<div style="font-size:16px;font-weight:700;color:' + color + '">' + title + '</div>' +
      '<div style="font-size:14px;margin-top:4px">By <b>' + esc_(res.decided_by) + '</b> on ' + Utilities.formatDate(new Date(), 'Asia/Kolkata', 'dd-MMM-yyyy hh:mm a') + '</div>' +
      (res.decision_remarks ? '<div style="font-size:14px;margin-top:4px">Remarks: ' + esc_(res.decision_remarks) + '</div>' : '') +
      '<div style="font-size:14px;margin-top:4px">Net payable: <b>₹ ' + inr_(final) + '</b></div></div>';
  };

  if (decision === 'Approved') {
    MailApp.sendEmail({
      to: FINANCE_EMAIL,
      cc: FINANCE_EMAIL.toLowerCase().indexOf(String(owner).toLowerCase()) >= 0 ? '' : owner,
      subject: ('Approved – ' + String(res.subject || 'Trip Settlement').replace(/^(Revised - )?Need Approval For /, '')).slice(0, 250),
      htmlBody: banner('#1d7a4a', 'APPROVED – please process the payment') + String(res.email_html || ''),
      name: SENDER_NAME
    });
    try { rpc_('ts_mark_finance_sent', { p_id: id, p_token: code }); } catch (err) {}
  } else {
    MailApp.sendEmail({
      to: owner,
      subject: ('Rejected – ' + String(res.subject || 'Trip Settlement').replace(/^(Revised - )?Need Approval For /, '')).slice(0, 250),
      htmlBody: banner('#b4322a', 'REJECTED – please review, edit and resend') + String(res.email_html || ''),
      name: SENDER_NAME
    });
  }
  return { already: false, status: res.status, decided_by: res.decided_by };
}

/* ---------------- helpers ---------------- */
function rpc_(fn, args) {
  const r = UrlFetchApp.fetch(SUPABASE_URL + '/rest/v1/rpc/' + fn, {
    method: 'post', contentType: 'application/json', payload: JSON.stringify(args),
    headers: { apikey: SUPABASE_KEY, Authorization: 'Bearer ' + SUPABASE_KEY },
    muteHttpExceptions: true
  });
  const txt = r.getContentText();
  if (r.getResponseCode() >= 300) {
    let msg = txt; try { msg = JSON.parse(txt).message || txt; } catch (e) {}
    throw new Error(msg);
  }
  return txt ? JSON.parse(txt) : null;
}
function esc_(s) { return String(s == null ? '' : s).replace(/[&<>"]/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]; }); }
function inr_(n) { return Number(n || 0).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 }); }

/** Run this once from the editor after updating the script, to grant permissions. */
function authorize() {
  Logger.log('Emails left today: ' + MailApp.getRemainingDailyQuota());
  Logger.log('Script owner: ' + Session.getEffectiveUser().getEmail());
  UrlFetchApp.fetch(SUPABASE_URL + '/auth/v1/health', { headers: { apikey: SUPABASE_KEY }, muteHttpExceptions: true });
}

function reply_(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj)).setMimeType(ContentService.MimeType.JSON);
}

/* ---------------- approval page ---------------- */
const PAGE_HTML = String.raw`<!doctype html>
<html><head><base target="_top"><meta charset="utf-8">
<style>
 body{margin:0;background:#f3f5f8;font-family:Arial,sans-serif;color:#18202c}
 .wrap{max-width:520px;margin:0 auto;padding:24px 16px}
 .card{background:#fff;border:1px solid #dde2e9;border-radius:10px;padding:18px}
 h1{font-size:20px;margin:0 0 4px}.sub{color:#5f6b7a;font-size:14px;margin-bottom:14px}
 .row{display:flex;justify-content:space-between;padding:7px 0;border-top:1px solid #eef1f4;font-size:14px}
 .row b{font-family:monospace;font-size:15px}
 label{display:block;font-size:12px;font-weight:700;letter-spacing:.05em;text-transform:uppercase;color:#5f6b7a;margin:12px 0 4px}
 input,textarea{width:100%;box-sizing:border-box;font:inherit;padding:9px 10px;border:1px solid #dde2e9;border-radius:7px}
 textarea{min-height:70px}
 .btn{width:100%;margin-top:14px;padding:12px;border:0;border-radius:8px;font:700 15px Arial;color:#fff;cursor:pointer}
 .approve{background:#1d7a4a}.reject{background:#b4322a}.btn:disabled{opacity:.6}
 .msg{margin-top:14px;padding:12px;border-radius:8px;font-size:14px}
 .ok{background:#e3f4ea;color:#1d7a4a}.err{background:#fbe7e5;color:#b4322a}.info{background:#fff6d6;color:#3a2c00}
 .switch{display:block;text-align:center;margin-top:12px;font-size:13px;color:#2563c9}
</style></head><body><div class="wrap"><div class="card">
<? if (!info) { ?>
  <h1>Link not valid</h1>
  <div class="msg err">This approval link has expired or is incorrect. If the settlement was edited and resent, please use the latest email.</div>
<? } else if (info.status !== 'Pending for Approval') { ?>
  <h1>Already <?= info.status ?></h1>
  <div class="sub"><?= info.driver ?> · <?= info.vehicle || '' ?></div>
  <div class="msg info">This settlement was <b><?= info.status ?></b><? if (info.decided_by) { ?> by <b><?= info.decided_by ?></b><? } ?>. No further action is needed.</div>
<? } else { ?>
  <h1><?= action === 'reject' ? 'Reject settlement' : 'Approve settlement' ?></h1>
  <div class="sub"><?= info.subject || '' ?></div>
  <div class="row"><span>Driver</span><span><?= info.driver ?></span></div>
  <div class="row"><span>Vehicle</span><span><?= info.vehicle || '-' ?></span></div>
  <div class="row"><span>Trips</span><span><?= info.trips ?></span></div>
  <div class="row"><span>Total amount</span><b>₹ <?= Number(info.net).toLocaleString('en-IN',{minimumFractionDigits:2}) ?></b></div>
  <? if (Number(info.debit) > 0) { ?><div class="row"><span>Debit<?= info.debit_remarks ? ' (' + info.debit_remarks + ')' : '' ?></span><b>− ₹ <?= Number(info.debit).toLocaleString('en-IN',{minimumFractionDigits:2}) ?></b></div><? } ?>
  <div class="row"><span>Net payable</span><b>₹ <?= (Number(info.net) - Number(info.debit || 0)).toLocaleString('en-IN',{minimumFractionDigits:2}) ?></b></div>
  <label for="nm">Your name</label><input id="nm" value="<?= who ?>" placeholder="Name of approver">
  <label for="rm">Remarks <?= action === 'reject' ? '(required)' : '(optional)' ?></label><textarea id="rm"></textarea>
  <button id="go" class="btn <?= action ?>"><?= action === 'reject' ? 'Confirm reject' : 'Confirm approve' ?></button>
  <div id="out"></div>
  <a class="switch" href="#" id="sw"><?= action === 'reject' ? 'Approve instead' : 'Reject instead' ?></a>
  <script>
    var action = <?!= JSON.stringify(action) ?>, id = <?!= JSON.stringify(id) ?>, code = <?!= JSON.stringify(code) ?>;
    var go = document.getElementById('go'), out = document.getElementById('out');
    document.getElementById('sw').onclick = function (e) { e.preventDefault();
      action = action === 'reject' ? 'approve' : 'reject';
      go.className = 'btn ' + action; go.textContent = action === 'reject' ? 'Confirm reject' : 'Confirm approve';
      document.querySelector('h1').textContent = action === 'reject' ? 'Reject settlement' : 'Approve settlement';
      document.querySelector('label[for=rm]').textContent = 'Remarks ' + (action === 'reject' ? '(required)' : '(optional)');
      this.textContent = action === 'reject' ? 'Approve instead' : 'Reject instead'; };
    go.onclick = function () {
      var nm = document.getElementById('nm').value.trim(), rm = document.getElementById('rm').value.trim();
      if (!nm) { out.innerHTML = '<div class="msg err">Please enter your name.</div>'; return; }
      if (action === 'reject' && !rm) { out.innerHTML = '<div class="msg err">Please give a reason for rejecting.</div>'; return; }
      go.disabled = true; go.textContent = 'Saving…';
      google.script.run.withSuccessHandler(function (r) {
        document.getElementById('sw').style.display = 'none'; go.style.display = 'none';
        if (r.already) out.innerHTML = '<div class="msg info">Already ' + r.status + (r.decided_by ? ' by ' + r.decided_by : '') + '. Nothing was changed.</div>';
        else if (r.status === 'Approved') out.innerHTML = '<div class="msg ok"><b>Approved.</b> The settlement has been sent to Finance for payment. You can close this page.</div>';
        else out.innerHTML = '<div class="msg err"><b>Rejected.</b> The sender has been informed. You can close this page.</div>';
      }).withFailureHandler(function (err) {
        go.disabled = false; go.textContent = action === 'reject' ? 'Confirm reject' : 'Confirm approve';
        out.innerHTML = '<div class="msg err">' + (err && err.message ? err.message : 'Something went wrong') + '</div>';
      }).decide(id, code, action, nm, rm);
    };
  </script>
<? } ?>
</div></div></body></html>`;
