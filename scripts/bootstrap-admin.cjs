require("dotenv/config");
const { createClient } = require("@supabase/supabase-js");
const email = process.argv[2]?.trim().toLowerCase();
const apply = process.argv.includes("--apply");
if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email))
  throw new Error(
    "Pass the authorized admin email as the first argument. No password is accepted.",
  );
const site = (
  process.env.AUTH_SITE_URL || "https://stayblz-frontend.vercel.app"
).replace(/\/$/, "");
const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SECRET_KEY,
  { auth: { persistSession: false, autoRefreshToken: false } },
);
(async () => {
  let existing = null;
  for (let page = 1; page <= 10; page++) {
    const { data, error } = await supabase.auth.admin.listUsers({
      page,
      perPage: 100,
    });
    if (error) throw error;
    existing =
      data.users.find((user) => user.email?.toLowerCase() === email) ?? null;
    if (existing || data.users.length < 100) break;
  }
  if (!apply) {
    console.log(
      JSON.stringify({
        mode: "dry-run",
        existingAccount: !!existing,
        alreadyAdmin: existing?.app_metadata?.stayblz_role === "superadmin",
        confirmed: !!existing?.email_confirmed_at,
        action: existing
          ? "Preserve account and assign server admin role if needed"
          : "Send admin invitation; require email verification and a new password",
        redirect: site + "/auth/confirm",
      }),
    );
    return;
  }
  let user = existing;
  let setupEmailRequested = false;
  if (!user) {
    const result = await supabase.auth.admin.inviteUserByEmail(email, {
      redirectTo: site + "/auth/confirm",
      data: { first_name: "Super", last_name: "Admin" },
    });
    if (result.error) throw result.error;
    user = result.data.user;
    setupEmailRequested = true;
  }
  if (!user)
    throw new Error(
      "Admin identity was not returned. No credentials were changed.",
    );
  if (user.app_metadata?.stayblz_role !== "superadmin") {
    const result = await supabase.auth.admin.updateUserById(user.id, {
      app_metadata: {
        ...user.app_metadata,
        stayblz_role: "superadmin",
        stayblz_require_password_setup: true,
      },
    });
    if (result.error) throw result.error;
  }
  if (
    existing &&
    (user.app_metadata?.stayblz_role !== "superadmin" ||
      user.app_metadata?.stayblz_require_password_setup === true)
  ) {
    const result = user.email_confirmed_at
      ? await supabase.auth.resetPasswordForEmail(email, {
          redirectTo: site + "/auth/confirm",
        })
      : user.invited_at
        ? await supabase.auth.admin.inviteUserByEmail(email, {
            redirectTo: site + "/auth/confirm",
          })
        : await supabase.auth.resend({
            type: "signup",
            email,
            options: { emailRedirectTo: site + "/auth/confirm" },
          });
    if (result.error) throw result.error;
    setupEmailRequested = true;
  }
  console.log(
    JSON.stringify({
      ok: true,
      accountPreserved: !!existing,
      adminRoleAssigned: true,
      setupEmailRequested,
      emailConfirmed: !!user.email_confirmed_at,
      passwordSetupRequired:
        user.app_metadata?.stayblz_require_password_setup !== false,
    }),
  );
})().catch((error) => {
  console.error(
    JSON.stringify({
      ok: false,
      error: error.code || error.name || "provider_error",
      message:
        "Admin setup did not finish. Check SMTP/redirect configuration and retry. No password or verification link is printed.",
    }),
  );
  process.exitCode = 1;
});
