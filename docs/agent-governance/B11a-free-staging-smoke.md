# B11a — FREE STAGING SMOKE（deployed verification）

**Service**: <https://insighthub-staging-he517.onrender.com>
**Blueprint**: `render.staging.yaml` · plan `free` · **no Persistent Disk** · `INSIGHTHUB_DATA_PATH=/tmp/insighthub-data`
**Date**: 2026-10-23 · **Verifier**: A0 (read-only probes; no Render or Clerk credential was read)

> **EPHEMERAL / TEST-ONLY.** The staging database lives in `/tmp` on a free instance. A restart,
> redeploy or inactivity spin-down discards it. Nothing in this report proves production
> persistence, restart durability or deployed backup/restore; those stay OPEN (D-083).

## 1. Results

| # | Check | Result | Evidence |
| --- | --- | --- | --- |
| 1 | `GET /health` | **PASS** | `200 {"status":"ok"}` |
| 2 | `GET /ready` | **PASS** | `200 {"status":"ready"}` |
| 3 | `GET /api/meta` | **PASS** | `200`, `insighthub-server` |
| 4 | SPA shell (`/`) | **PASS** | `200`, contains `id="root"` and a module script (522 bytes) |
| 5 | Static asset | **PASS** | `/assets/index-Bkhll_b5.js` → `200`, `text/javascript` |
| 6 | SPA fallback (`/documents/some-id`) | **PASS** | `200`, same shell |
| 7 | Unknown API path stays JSON | **PASS** | `/api/unknown` → `404 {"error":"not_found"}` even with `Accept: text/html` |
| 8 | Demo bootstrap disabled | **PASS** | `POST /api/session/bootstrap` → `404 {"error":"not_found"}`, **no `Set-Cookie`** |
| 9 | Foreign Origin rejected | **PASS** | `403 {"error":"origin_not_allowed"}` (POST and OPTIONS preflight) |
| 10 | Unauthenticated API | **PASS** | `/api/session` and `/api/documents` → `401 {"error":"session_required"}` |
| 11 | Source maps not served | **PASS** | `/assets/index.js.map` → `404` |
| 12 | WSS: foreign Origin | **PASS** | handshake `403 origin_not_allowed`, **socket not opened** |
| 13 | WSS: trusted Origin, no cookie | **PASS** | `401`, socket not opened (Clerk mode fails closed) |
| 14 | WSS: no Origin, no cookie | **PASS** | `401`, socket not opened |
| 15 | TLS certificate | **PASS** | `authorized=true`; issuer Google Trust Services; valid to 2026-12-20 |
| 16 | HTTP → HTTPS | **PASS** | `301` → `https://…/health` |
| 17 | AI auth precedes provider config | **PASS** | `POST /api/ai/suggest` unauthenticated → `401 session_required` (not 503) |
| 18 | Clerk surface renders | **PASS** | real headless Chrome: `auth-gate[data-state=signed-out]`, `clerk-sign-in`, Clerk loaded, **editor not mounted** |
| 19 | Sign-in methods visible | **PASS** | rendered text: “Continue with **Google**” + email/password, “Secured by Development mode” |

**Totals: 19/19 PASS** across HTTP (13), WSS (3), TLS/redirect/AI-order (3), browser/Clerk (2+).

The production build itself succeeded on the free 512 MB instance, so the B7/B10 packaging is
deployable without a paid plan for a smoke.

## 2. NOT VERIFIED (do not infer from this report)

| Item | Why | Status |
| --- | --- | --- |
| Clerk sign-in round-trip (email or Google) | requires the owner's credentials; an agent must not perform a third-party login | **NOT VERIFIED** |
| Data survives restart / redeploy / spin-down | free instance, no disk, `/tmp` store — by design | **NOT VERIFIED / OPEN** |
| Deployed backup + restore drill | `BACKUP_ENABLED=false`, no disk | **NOT VERIFIED / OPEN** |
| Render deploy-log shape (JSON lines) | no Render log access from this session; local B10 evidence exists | **NOT VERIFIED** |
| Linux `SIGTERM → exit 0` re-run of `tests/production/run.mjs` | verifier host is Windows; Render offers no shell here | **NOT VERIFIED** (B10 Windows SKIP remains) |
| AI live provider | B11a runs AI **disabled** by design; B12 | **NOT VERIFIED** |
| Custom domain / capacity / zero-downtime | out of B11a scope | **NOT VERIFIED** |

## 3. Status impact

- **B11a**: **DONE** (19/19 checks above).
- **B11** (paid + disk + restart durability): **OPEN — BLOCKED BY PAYMENT**.
- **B8 deployed backup/restore**: **OPEN — BLOCKED BY PAYMENT**.
- **B12**: may proceed on this staging service (AI does not depend on a disk).
- **B13**: may run the non-durable functional subset, marked per item.
- **B14**: **BLOCKED** until a paid persistent deployment is verified.

## 4. Residual observations

- Free instances spin down when idle; the first request after idle is slow (the Clerk check
  needed several seconds of warm-up before the gate resolved to `signed-out`).
- Clerk is a **development** instance (“Development mode” badge), which is expected for staging;
  the production Clerk instance is part of the paid-production cutover.
- The staging URL is `https://insighthub-staging-he517.onrender.com`, matching the
  `render.staging.yaml` service name; `CORS_ORIGIN` resolved from `RENDER_EXTERNAL_URL`, so the
  self-reference works in practice (it needed no manual hostname entry).
