// Builds the Supabase Auth email templates in email-templates/ from one shared layout.
// Run: node scripts/build-email-templates.cjs   (then paste each file into
// Supabase → Authentication → Emails → Templates; see email-templates/README.md).
// Email clients ignore most CSS, so everything is table-based with inline styles.
//
// Every email is link-only (no 6-digit codes since 2026-11-19): one button that opens Stayblz at /auth/confirm with
// the one-time token. That page sends the token with its script, so a mail scanner that only fetches the link can't
// use it up. Never use {{ .ConfirmationURL }}: it confirms on a plain GET.
//
// Look: the Stayblz glass theme (slate page, white card, ink crest, emerald button). No serif, no gold.
const fs = require("fs");
const path = require("path");

// Must match Supabase → Authentication → Providers → Email → "Email OTP Expiration" (3600 seconds); links use it too.
const LINK_LIFETIME = "1 hour";

const c = {
  page: "#eef2f9",
  card: "#ffffff",
  ink: "#0b1324",
  text: "#1e293b",
  muted: "#64748b",
  line: "#e2e8f0",
  accent: "#0d9f74",
  accentDeep: "#0a7f5d",
  blue: "#3b6cf6",
  soft: "#f1f5f9",
};
const sans = "'Archivo', 'Helvetica Neue', Helvetica, Arial, sans-serif";

const button = (href, label) => `
<table role="presentation" cellpadding="0" cellspacing="0" border="0" style="margin:6px 0 22px;">
  <tr><td bgcolor="${c.accent}" style="border-radius:12px;background:${c.accent};">
    <a href="${href}" style="display:inline-block;padding:15px 28px;font:700 16px ${sans};color:#ffffff;text-decoration:none;border-radius:12px;border:1px solid ${c.accentDeep};">${label}</a>
  </td></tr>
</table>`;

/** For mail apps that break buttons: the same link as text. */
const linkText = (href) => `
<p style="margin:0 0 6px;font:12px/1.6 ${sans};color:${c.muted};">Button not working? Copy this link into your browser:</p>
<p style="margin:0 0 22px;padding:10px 12px;background:${c.soft};border:1px solid ${c.line};border-radius:10px;font:12px/1.5 'Courier New', monospace;color:${c.text};word-break:break-all;">${href}</p>`;

function layout({ preheader, kicker, title, body, footnote, footer }) {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="color-scheme" content="light">
<meta name="supported-color-schemes" content="light">
<meta name="x-apple-disable-message-reformatting">
<meta name="format-detection" content="telephone=no, date=no, address=no, email=no">
<title>${title}</title>
</head>
<body style="margin:0;padding:0;background:${c.page};">
<div style="display:none;max-height:0;overflow:hidden;opacity:0;">${preheader}</div>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" bgcolor="${c.page}">
<tr><td align="center" style="padding:32px 14px;">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="max-width:540px;">
    <tr><td align="left" style="padding:0 6px 16px;">
      <table role="presentation" cellpadding="0" cellspacing="0" border="0"><tr>
        <td style="padding-right:10px;vertical-align:middle;"><img src="{{ .SiteURL }}/icons/icon-192.png" width="36" height="36" alt="" style="display:block;border:0;border-radius:10px;"></td>
        <td style="vertical-align:middle;font:800 17px ${sans};letter-spacing:.18em;color:${c.ink};">STAYBLZ</td>
      </tr></table>
    </td></tr>
    <tr><td bgcolor="${c.card}" style="padding:34px 30px 8px;border:1px solid ${c.line};border-bottom:0;border-radius:18px 18px 0 0;">
      <p style="margin:0 0 10px;font:700 11px ${sans};letter-spacing:.16em;text-transform:uppercase;color:${c.accent};">${kicker}</p>
      <h1 style="margin:0 0 14px;font:800 26px/1.25 ${sans};letter-spacing:-.01em;color:${c.ink};">${title}</h1>
      ${body}
    </td></tr>
    <tr><td bgcolor="${c.card}" style="padding:0 30px 28px;border:1px solid ${c.line};border-top:0;border-radius:0 0 18px 18px;">
      <p style="margin:0;padding-top:18px;border-top:1px solid ${c.line};font:13px/1.6 ${sans};color:${c.muted};">${footnote}</p>
    </td></tr>
    <tr><td style="padding:18px 8px;font:12px/1.6 ${sans};color:${c.muted};text-align:center;">
      ${footer}<br>
      <a href="{{ .SiteURL }}" style="color:${c.muted};">stayblz-app.com</a>
    </td></tr>
  </table>
</td></tr>
</table>
</body>
</html>
`;
}

const p = (text) => `<p style="margin:0 0 18px;font:15px/1.65 ${sans};color:${c.text};">${text}</p>`;
const small = (text) => `<p style="margin:0 0 18px;font:13px/1.6 ${sans};color:${c.muted};">${text}</p>`;
const site = "{{ .SiteURL }}";
const confirmUrl = (type) => `${site}/auth/confirm?token_hash={{ .TokenHash }}&type=${type}`;
const notMeUrl = `${site}/auth/not-me?token_hash={{ .TokenHash }}`;
const once = `The link works once and expires in ${LINK_LIFETIME}. If you asked for more than one email, use the newest.`;
const footer = "Sent to {{ .Email }} by Stayblz. Stayblz staff will never ask for your password.";

const templates = {
  "confirm-signup": {
    supabase: "Confirm signup",
    subject: "Verify your email for Stayblz",
    html: layout({
      preheader: "One tap to verify your email and finish creating your Stayblz account.",
      kicker: "Verify your email",
      title: "Welcome to Stayblz",
      body:
        p("Tap the button to verify your email and finish creating your account.") +
        button(confirmUrl("email"), "Verify my email") +
        small(once) +
        linkText(confirmUrl("email")) +
        small("After that, you can add your racing details to your profile."),
      footnote:
        `<strong>Didn't sign up?</strong> Someone may have typed your email by mistake. ` +
        `<a href="${notMeUrl}" style="color:${c.ink};font-weight:700;">This wasn't me — remove this sign-up</a>. ` +
        `If you ignore this email, the account stays unverified and can't be used.`,
      footer,
    }),
    text: [
      "Welcome to Stayblz - verify your email",
      "",
      "Open this link to verify your email and finish creating your account:",
      confirmUrl("email"),
      "",
      once,
      "",
      "Didn't sign up? Someone may have typed your email by mistake. Remove the sign-up here:",
      notMeUrl,
      "If you ignore this email, the account stays unverified and can't be used.",
      "",
      footer,
    ],
  },
  "reset-password": {
    supabase: "Reset password",
    subject: "Reset your Stayblz password",
    html: layout({
      preheader: "Choose a new password for your Stayblz account.",
      kicker: "Password reset",
      title: "Choose a new password",
      body:
        p("We got a request to reset the password for your Stayblz account. Tap the button to choose a new one.") +
        button(confirmUrl("recovery"), "Choose a new password") +
        small(once) +
        linkText(confirmUrl("recovery")),
      footnote:
        "<strong>Didn't ask for this?</strong> You can ignore this email. Your password stays the same, and nobody can " +
        "change it without this link. If you get these emails often, change your password and turn on 2-step login.",
      footer,
    }),
    text: [
      "Reset your Stayblz password",
      "",
      "Open this link to choose a new password:",
      confirmUrl("recovery"),
      "",
      once,
      "",
      "Didn't ask for this? You can ignore this email. Your password stays the same.",
      "",
      footer,
    ],
  },
  invite: {
    supabase: "Invite user",
    subject: "You're invited to Stayblz",
    html: layout({
      preheader: "Accept your invitation and set a password.",
      kicker: "Invitation",
      title: "You've been invited to Stayblz",
      body:
        p("Accept the invitation to set your password and open your account.") +
        button(confirmUrl("invite"), "Accept invitation") +
        small(`The link works once and expires in ${LINK_LIFETIME}.`) +
        linkText(confirmUrl("invite")),
      footnote: "<strong>Not expecting this?</strong> Ignore this email and no account will be activated.",
      footer,
    }),
  },
  "change-email": {
    supabase: "Change email address",
    subject: "Confirm your new Stayblz email",
    html: layout({
      preheader: "Confirm the new email address for your Stayblz account.",
      kicker: "Email change",
      title: "Confirm your new email",
      body:
        p("Confirm that {{ .NewEmail }} should become the email for your Stayblz account.") +
        button(confirmUrl("email_change"), "Confirm new email") +
        linkText(confirmUrl("email_change")),
      footnote: "<strong>Didn't ask for this?</strong> Don't use the link. Change your password and turn on 2-step login.",
      footer,
    }),
  },
};

// Every template: our own link with the one-time token, no code, no provider link that confirms on a plain visit.
for (const [name, { html, text = [] }] of Object.entries(templates)) {
  const all = html + text.join("\n");
  if (!all.includes("/auth/confirm?token_hash={{ .TokenHash }}")) throw new Error(`${name} must link to /auth/confirm`);
  if (/\{\{\s*\.Token\s*\}\}|ConfirmationURL|RedirectTo/.test(all)) throw new Error(`${name} must not show a code or a provider link`);
  if (/Georgia|#c5a468|#f4f0e6/i.test(html)) throw new Error(`${name} uses the retired theme`);
}

const out = path.join(__dirname, "..", "email-templates");
// Older outputs (code-only versions and the "with-links" folder) are replaced by these.
for (const old of ["with-links", "confirm-signup.txt", "reset-password.txt"])
  fs.rmSync(path.join(out, old), { recursive: true, force: true });
const rows = [];
for (const [name, { supabase, subject, html, text }] of Object.entries(templates)) {
  const file = path.join(out, name);
  fs.writeFileSync(`${file}.html`, html);
  fs.writeFileSync(`${file}.subject.txt`, subject + "\n");
  if (text) fs.writeFileSync(`${file}.txt`, text.join("\n") + "\n");
  rows.push(`| ${supabase} | \`${name}.subject.txt\` | ${subject} | \`${name}.html\` |`);
}
fs.writeFileSync(
  path.join(out, "subjects.md"),
  "| Supabase template | Subject file | Subject line | Body file |\n| --- | --- | --- | --- |\n" + rows.join("\n") + "\n",
);
console.log(`Wrote ${Object.keys(templates).length} templates to ${out}`);
