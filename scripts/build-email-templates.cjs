// Builds the Supabase Auth email templates in email-templates/ from one shared layout.
// Run: node scripts/build-email-templates.cjs   (then paste each file into
// Supabase → Authentication → Emails → Templates; see email-templates/README.md).
// Email clients ignore most CSS, so everything is table-based with inline styles.
const fs = require("fs");
const path = require("path");

const c = {
  forest: "#142820",
  deep: "#0f1e19",
  gold: "#c5a468",
  paper: "#f4f0e6",
  ink: "#1d2a22",
  muted: "#5b6b5f",
  line: "#e2dccb",
};
const font = "Georgia, 'Times New Roman', serif";
const sans = "'Helvetica Neue', Arial, sans-serif";

const button = (href, label) => `
<table role="presentation" cellpadding="0" cellspacing="0" border="0" style="margin:8px 0 24px;">
  <tr><td bgcolor="${c.gold}" style="border-radius:4px;">
    <a href="${href}" style="display:inline-block;padding:14px 26px;font:700 15px ${sans};color:${c.deep};text-decoration:none;border-radius:4px;">${label}</a>
  </td></tr>
</table>`;

const codeBox = (label) => `
<p style="margin:0 0 8px;font:600 12px ${sans};letter-spacing:.12em;text-transform:uppercase;color:${c.muted};">${label}</p>
<p style="margin:0 0 24px;padding:16px 20px;background:${c.paper};border:1px solid ${c.line};border-radius:6px;font:700 32px 'Courier New', monospace;letter-spacing:.35em;color:${c.ink};text-align:center;">{{ .Token }}</p>`;

function layout({ preheader, kicker, title, body, footnote }) {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="color-scheme" content="light">
<title>${title}</title>
</head>
<body style="margin:0;padding:0;background:#ece8dc;">
<div style="display:none;max-height:0;overflow:hidden;opacity:0;">${preheader}</div>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" bgcolor="#ece8dc">
<tr><td align="center" style="padding:28px 12px;">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="max-width:560px;">
    <tr><td bgcolor="${c.forest}" style="padding:22px 28px;border-radius:8px 8px 0 0;">
      <span style="font:700 20px ${font};letter-spacing:.08em;color:${c.paper};">STAYBLZ<span style="color:${c.gold};">.</span></span>
      <span style="display:block;margin-top:4px;font:600 10px ${sans};letter-spacing:.22em;color:${c.gold};">THE RACING LEDGER</span>
    </td></tr>
    <tr><td bgcolor="#ffffff" style="padding:32px 28px 8px;border-left:1px solid ${c.line};border-right:1px solid ${c.line};">
      <p style="margin:0 0 10px;font:600 11px ${sans};letter-spacing:.18em;text-transform:uppercase;color:${c.muted};">${kicker}</p>
      <h1 style="margin:0 0 18px;font:400 28px/1.25 ${font};color:${c.ink};">${title}</h1>
      ${body}
    </td></tr>
    <tr><td bgcolor="#ffffff" style="padding:0 28px 28px;border:1px solid ${c.line};border-top:0;border-radius:0 0 8px 8px;">
      <p style="margin:0;padding-top:18px;border-top:1px solid ${c.line};font:13px/1.6 ${sans};color:${c.muted};">${footnote}</p>
    </td></tr>
    <tr><td style="padding:18px 8px;font:12px/1.6 ${sans};color:${c.muted};text-align:center;">
      Sent to {{ .Email }} by Stayblz. Stayblz staff will never ask for your password or this code.<br>
      Stayblz is in early development.
    </td></tr>
  </table>
</td></tr>
</table>
</body>
</html>
`;
}

const p = (text) => `<p style="margin:0 0 18px;font:15px/1.65 ${sans};color:${c.ink};">${text}</p>`;
const site = "{{ .SiteURL }}";

const templates = {
  "confirm-signup.html": {
    subject: "Your Stayblz code: {{ .Token }}",
    html: layout({
      preheader: "Confirm your email to finish creating your Stayblz account.",
      kicker: "Confirm your email",
      title: "Welcome to Stayblz",
      body:
        p("Enter this code on the sign-up screen, or use the button. Either one confirms your email.") +
        codeBox("Your 6-digit code") +
        button(`${site}/auth/confirm?token_hash={{ .TokenHash }}&type=email`, "Confirm my email") +
        p("The code and button work once and expire soon."),
      footnote:
        `<strong>Didn't sign up?</strong> Someone may have typed your email by mistake. ` +
        `<a href="${site}/auth/not-me?token_hash={{ .TokenHash }}" style="color:${c.forest};font-weight:700;">This wasn't me — remove this sign-up</a>. ` +
        `If you ignore this email, the account stays unconfirmed and can't be used.`,
    }),
  },
  "reset-password.html": {
    subject: "Reset your Stayblz password",
    html: layout({
      preheader: "Use this code or button to choose a new Stayblz password.",
      kicker: "Password reset",
      title: "Choose a new password",
      body:
        p("We got a request to reset the password for your Stayblz account.") +
        codeBox("Your 6-digit code") +
        button(`${site}/auth/confirm?token_hash={{ .TokenHash }}&type=recovery`, "Reset my password") +
        p("The code and button work once and expire soon."),
      footnote:
        "<strong>Didn't ask for this?</strong> You can ignore this email. Your password stays the same, " +
        "and nobody can change it without this code. If you get these emails often, change your password and turn on 2-step login.",
    }),
  },
  "invite.html": {
    subject: "You're invited to Stayblz",
    html: layout({
      preheader: "Accept your invitation and set a password.",
      kicker: "Invitation",
      title: "You've been invited to Stayblz",
      body:
        p("Accept the invitation to set your password and open your account.") +
        button(`${site}/auth/confirm?token_hash={{ .TokenHash }}&type=invite`, "Accept invitation") +
        p("This button works once and expires soon."),
      footnote: "<strong>Not expecting this?</strong> Ignore this email and no account will be activated.",
    }),
  },
  "change-email.html": {
    subject: "Confirm your new Stayblz email",
    html: layout({
      preheader: "Confirm the new email address for your Stayblz account.",
      kicker: "Email change",
      title: "Confirm your new email",
      body:
        p("Confirm that {{ .NewEmail }} should become the email for your Stayblz account.") +
        button(`${site}/auth/confirm?token_hash={{ .TokenHash }}&type=email_change`, "Confirm new email"),
      footnote:
        "<strong>Didn't ask for this?</strong> Don't click the button. Change your password and turn on 2-step login.",
    }),
  },
};

const out = path.join(__dirname, "..", "email-templates");
fs.mkdirSync(out, { recursive: true });
const subjects = [];
for (const [file, { subject, html }] of Object.entries(templates)) {
  fs.writeFileSync(path.join(out, file), html);
  subjects.push(`| ${file} | ${subject} |`);
}
fs.writeFileSync(path.join(out, "subjects.md"), "| Template file | Subject line |\n| --- | --- |\n" + subjects.join("\n") + "\n");
console.log(`Wrote ${Object.keys(templates).length} templates to ${out}`);
