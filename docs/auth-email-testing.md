# Local Supabase email verification testing

Testing uses the existing Supabase project and its built-in email sender. No custom SMTP server, sender domain, provider setting, schema, or backend authorization bypass is introduced. The initial testing pass was local; the user subsequently authorized production publication of the reviewed fixes.

The built-in sender only permits authorized organization addresses and has a small shared sending quota. Signup, resend, and recovery requests all use that quota. A successful API request means the provider accepted the request, not that inbox delivery or confirmation was observed. See the official [testing guide](https://supabase.com/docs/guides/auth/testing-auth-flows) and [rate limits](https://supabase.com/docs/guides/auth/rate-limits).

## Expected behavior

| Case | Expected result |
| --- | --- |
| Valid signup | 202, Check your email screen, no authenticated cookies |
| Unconfirmed credentials | 403 with email_not_confirmed, no session |
| Unconfirmed workspace request | 401 |
| Confirmed member requests shared stable data | 403; verification does not grant stable/admin permission |
| Unauthorized recipient | 403, clear built-in sender restriction; never a sent-email screen |
| Provider email/request limit | 429, structured code and Retry-After; no automatic resend |
| Local abuse limit | 429, matching header/body cooldown |
| Unknown account email request | Generic conditional 202 response, preserving account privacy |
| Mail service failure | 503, no false success message |
| Expired/used link | Safe callback error, credentials/errors removed from the URL |

Client cooldowns use elapsed time, including when a tab was suspended. An email-only limit does not disable password login. A 60-second minimum cooldown does not promise that the provider's project-wide email quota has reset. Raw provider messages, keys, passwords and verification links are never included in public errors or test output.

## Optional real provider test

Build the backend first. Run `node scripts/test-auth-email.cjs <authorized-test-email>` for a read-only preflight. Add `--send` only to request an actual signup email for a separate authorized test account. Do not use the superadmin email or overwrite an existing account; the helper stops if the account already exists.

The helper starts an isolated loopback API instance and keeps a random password in process memory. It uses the existing callback configuration (default local frontend: `http://localhost:5173`); the provider's registered redirects determine where its email opens. Open that email in a private browser window. Do not copy its link or tokens into logs/chat. Confirmation must be completed through the real emailed link, not a generated admin token or auto-confirm operation.

After confirmation, enter `check` in the retained terminal. It tests verified login, HttpOnly cookies, session restore, denial of shared stable data, password change on this test account only, rejection of the previous password, and logout. `reset` requests one recovery email after those checks; inbox delivery and following its real reset link are separate observations. `quit` stops the helper. No account is deleted. The temporary password is not saved; an owner who keeps this test account can use normal email recovery.

Deterministic automated tests mock provider delivery/restriction/rate responses instead of deliberately exhausting the real project's quota. They do not prove actual inbox delivery or that a human completed the callback. Record live and mocked results separately.

## Validation recorded for this local pass

- Frontend release checks: 33 browser tests passed; production build passed.
- Backend release checks: 30 API tests passed, including the TypeScript build. Both dependency audits reported zero vulnerabilities.
- Real provider: a separate authorized signup returned 202; unverified login returned 403 with email_not_confirmed; anonymous private workspace access returned 401.
- The owner reported successful email confirmation; a subsequent read-only provider lookup independently confirmed the test account's verified email and absence of a superadmin role.
- A single real recovery request returned 429 with over_email_send_rate_limit and the safe quota message. No automatic retries were made. Recovery delivery/reset and live verified password login/logout remain unverified; the original temporary password was discarded when the integration process closed. Existing superadmin credentials and profile remain untouched.
- No provider settings or schema were changed. Production publication was subsequently authorized; deployment verification must be recorded separately from these local checks.
