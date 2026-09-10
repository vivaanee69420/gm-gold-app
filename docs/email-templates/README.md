# Supabase auth email templates

These two files are **reference copies**. The live versions are pasted into the Supabase
dashboard (Authentication → Emails → Templates), because auth email is sent by Supabase over
SMTP rather than by our API — decision T2, 2026-09-09. Routing it through our API instead
(the Send Email hook) would put Railway cold-start latency on the login path, which turns
into codes that intermittently never arrive.

Keeping a copy here means the templates are reviewable in a diff and restorable if someone
edits the dashboard and regrets it. They are NOT deployed from here. Changing a file in this
directory changes nothing until it is pasted into the dashboard.

The app's own emails (`wallet_credit`, `payout_receipt`) are different: those ARE in code, at
`apps/api/src/services/templates/index.js`, and ship with the API.

| File | Dashboard template | Sent to |
|---|---|---|
| `confirm-signup.html` | **Confirm sign up** | a patient signing in for the FIRST time |
| `magic-link-or-otp.html` | **Magic link or OTP** | a patient who already has an account |

## Both are required

`signInWithOtp` picks the template by whether the user already exists. Update only "Magic
link or OTP" and you will test successfully with your own account while every genuinely new
patient receives the untouched default — a confirmation LINK, not a code. The app has no
deep-link handling (`detectSessionInUrl: false`), so they would tap it and land nowhere.

Always test with an address that has never signed in to this project.

## `{{ .Token }}`, not `{{ .ConfirmationURL }}`

Magic links and OTPs are the same mechanism in Supabase; the template decides which one the
patient gets. `{{ .Token }}` renders the six-digit code. Q3 chose codes over links because a
code works when the mail client opens on a different device from the app.

## Set the code LENGTH to match the app

`{{ .Token }}` renders however many digits **Email OTP Length** is set to under Authentication
→ Sign In / Providers → Email. Supabase allows 6–10; the app expects **6** (`OTP_LENGTH` in
`apps/mobile/src/screens/auth.js`).

On 2026-09-10 the dashboard was on 8 while the app said 6, and the failure was silent in the
worst way: the code field truncated the last two digits, the Sign in button lit up as if the
code were complete, and Supabase rejected it as "wrong or expired" — which reads to a patient
as *you typed it wrong*. The field now accepts up to 10 so a mismatch can never truncate, but
the two numbers must still agree or the label lies.

## Set the expiry to match the copy

These templates say the code expires in **10 minutes**. Supabase's default is 3600 seconds.
Set **Email OTP Expiration** to `600` under Authentication → Sign In / Providers → Email,
or edit the copy. A shorter window is the better default for a code that grants a session,
and 10 minutes is ample for switching to an email app and back.

`VerifyScreen` in the mobile app states the same 10 minutes. Three places, one number.
