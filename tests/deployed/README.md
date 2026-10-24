# Deployed smoke (opt-in)

Scripts here talk to a **real deployment** and a **real identity provider**. They are not part of
`pnpm test` or the default browser suite, which must stay offline and deterministic.

## `b13.mjs` — staging functional smoke

Proves the full product chain on `https://insighthub-staging-he517.onrender.com`:

```text
Clerk sign-up (development test email + OTP 424242)
  → real Clerk session → app_user mapping (GET /api/session returns an internal id)
  → New document (self-service) → owner authorization → edit
  → real OpenAI generation → Diff Preview → Accept → Reject
  → sign-out
```

No fixture seeds a document or a membership: the document is created through the product's own
`New document` entry.

### Credentials

Put the Clerk **secret key** in a gitignored file — never in the repository, a shell history you
share, or a report:

```text
tests/deployed/.env.local
CLERK_SECRET_KEY=sk_...
```

`*.local` is ignored by `.gitignore`. The script reads it at runtime to mint a short-lived Clerk
**Testing Token** (`POST /v1/testing_tokens`), which only bypasses the bot challenge during the
test; the session it obtains is a real Clerk development session. The token is passed to the page
as Clerk's documented `?__clerk_testing_token=` query parameter and is never printed.

At the end the script deletes the disposable `+clerk_test` user through the Backend API, when the
page exposes its id. The staging database lives in `/tmp` (free instance, no disk), so its test
data disappears on the next deploy or spin-down; there is no document-delete API to call.

### Run

```bash
node tests/deployed/b13.mjs
```

Exit codes: `0` all checks passed, `1` a check failed, `2` no credential was available (nothing
was sent).

### Deliberately out of scope

- persistence/restart/backup evidence (free staging has no disk; `D-083` keeps those OPEN);
- real e-mail delivery (the `+clerk_test` account is a Clerk development test user);
- any production runtime behaviour: the Testing Token exists only in this harness.
