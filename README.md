# nama-monitor

Synthetic funnel monitor for [heynama.com](https://heynama.com) and [getnama.com](https://getnama.com). Runs Playwright E2E tests on a schedule via GitHub Actions and dispatches a Claude-driven diagnose-and-Slack pipeline when something breaks.

The monitor exists because both sites run paid Meta and Google Ads. Every minute the funnel silently breaks is ad budget burning, so detection has to be fast and the diagnosis has to be useful at 3am.

---

## What it checks

| Job | Cadence | Steps |
|---|---|---|
| **Smoke** | every 15 min | home + PDP load with HTTP < 400, Add-to-Cart button visible |
| **Full e2e** | every 30 min | smoke + click Add-to-Cart + assert cart fragment increments + visit `/checkout/` + assert redirect to a valid Shopify checkout URL with HTTP < 400 |

**Debounce + CF gating:** when a run fails, the workflow waits 90 s and re-runs once. The diagnose script and Slack alert only fire if **both** attempts fail **and** the failures weren't all Cloudflare bot challenges. CF-only failures are suppressed (the workflow run is marked green) — they're noise the team can't act on, and Cloudflare flakes account for most isolated failures.

CF detection uses three independent signals on the failed page: URL pattern (`cdn-cgi/challenge-platform`, `__cf_chl_`), document title (`Just a moment...`, `Attention required`), and body text (`Verifying you are human`, `Cloudflare Ray ID`). See `isCloudflareChallenge` in `tests/utils.ts`.

The full e2e exercises the **WordPress → Shopify Storefront API bridge**, which is the most fragile part of the funnel: WP redirects `/checkout/` to a Shopify-hosted checkout via `cartCreate`, and that bridge depends on a Storefront token, the `shopify_id` ACF field on each product, and valid selling-plan IDs.

The redirect target may be `nama-cbd.myshopify.com/checkouts/...` or the branded `www.namacbd.com/checkouts/...` — both are accepted.

---

## Architecture

Three layers, two of which live here:

| Layer | Tool | Where | Cadence |
|---|---|---|---|
| 1. Sub-minute uptime | BetterStack / UptimeRobot (recommended, **not** in this repo) | external | every 1 min |
| 2. Funnel correctness | Playwright in GitHub Actions | this repo (`tests/`) | 15 / 30 min |
| 3. Failure diagnosis | Claude Agent SDK + Playwright MCP | this repo (`scripts/diagnose.mjs`) | only on double-failure |

Layer 1 is a hard recommendation — GitHub Actions cron has 5–15 min drift in peak hours, so this monitor is **not** a real-time uptime check.

---

## Slack output

Two channels of output, both gated on the test outcome:

- **Failure (full diagnosis):** Claude navigates the live site with Playwright MCP, takes screenshots, reads console errors, and posts a structured diagnosis. The message tags the user IDs in `SLACK_MENTION_USER_IDS` so on-call gets pinged. Tagged with `🚨 NAMA FUNNEL DOWN 🚨`.
- **Failure (truncated / fallback):** if the diagnose script hits its 8-minute internal timeout, it posts whatever partial report Claude produced with a `_⚠️ Diagnosis truncated_` note. If the diagnose step itself crashes or gets cancelled before posting, a workflow-level fallback step posts a minimal alert linking to the workflow run and asking for manual verification. Either way, **the on-call always gets a message** when the funnel double-fails — silent failures are not possible.
- **Success heartbeat:** posted only after **full e2e** runs (every 30 min) and `workflow_dispatch` runs. Smoke runs are silent — at 96/day they would drown the channel.

Set `SLACK_WEBHOOK_URL_SUCCESS` to route heartbeats to a separate channel from failures (recommended).

### Reliability of the alert pipeline

Defence in depth against the diagnose step burning time fighting Cloudflare and dying silently:

| Layer | Trigger | What happens |
|---|---|---|
| Cloudflare-challenge classifier | After both attempts fail | If all failed tests show CF challenge fingerprints, the alert pipeline is short-circuited and the run is marked green |
| `AbortController` inside `diagnose.mjs` | 8 min wall-clock | Aborts the SDK query, posts partial or fallback message via the same webhook |
| Step-level `timeout-minutes: 9` | 9 min | Step is marked failed; the next workflow step (fallback alert) takes over |
| Fallback step (`notify-diagnose-failed.mjs`) | Diagnose step did not finish `success` AND failures aren't CF-only | Posts a minimal alert with workflow run URL, asking the on-call to verify manually |
| Job-level `timeout-minutes: 20` | 20 min | Last resort. Should never be reached; if it is, the prior layers leaked. |

`maxTurns` on the SDK is capped at 15. Beyond that, more turns rarely converge — better to fail fast and let the fallback fire.

---

## Configuration

### Secrets (`gh secret set`)

| Name | Required | Purpose |
|---|---|---|
| `ANTHROPIC_API_KEY` | yes | Claude API for the diagnose script |
| `SLACK_WEBHOOK_URL` | yes | Failure alerts (and success heartbeats by default) |
| `SLACK_WEBHOOK_URL_SUCCESS` | no | Optional separate channel for heartbeats |

### Variables (`gh variable set`)

| Name | Default | Purpose |
|---|---|---|
| `CLAUDE_MODEL` | `claude-sonnet-4-6` | Override to `claude-haiku-4-5` (cheaper) or `claude-opus-4-7` (deeper reasoning) |
| `SLACK_MENTION_USER_IDS` | none | Slack member IDs to @mention on failure (space- or comma-separated, e.g. `U01ABC23DEF U02XYZ45GHI`) |

---

## Local development

```bash
npm install
npx playwright install --with-deps chromium
npm run test:smoke   # smoke only (~10s)
npm test             # full e2e (~30s, hits live sites)
```

Local runs hit production. They don't fill checkout forms or place orders, but **they do trigger `?add-to-cart=` on the WP origin**, which means the Shopify-side cart counter for synthetic users will tick up — harmless, just be aware.

---

## Cloudflare / Bot Fight Mode

Both sites are fronted by Cloudflare (managed by Cloudways, not directly accessible to this team). The first CI run was blocked by Bot Fight Mode flagging the default headless signals. Mitigations live in [`tests/utils.ts`](tests/utils.ts) (`applyStealth`):

- Removed the explicit `NamaMonitor/1.0` User-Agent (default Chromium UA passes).
- `navigator.webdriver` returns `undefined`.
- `navigator.appVersion` and `navigator.userAgent` strip `HeadlessChrome`.
- `window.chrome` mocked.
- `navigator.plugins` and `navigator.languages` populated.
- `permissions.query` notification quirk patched.

This is a stopgap. Cloudflare bot detection improves over time — if it starts blocking again, the durable fix is to relocate the runner to a VPS with a less-flagged IP (see Stretch goals).

---

## Cost

**GitHub Actions:** $0. Public repo → unlimited Linux minutes.

**Anthropic API (Sonnet 4.6 default):** ~$0.30–$1.00 per failure diagnose, depending on how many MCP tool calls Claude needs.

| Scenario | Diagnoses/month | Estimated cost |
|---|---|---|
| Healthy funnel (1–2 flakes/day, mostly suppressed by 90s in-run debounce) | 10–30 | **$5–$25** |
| One short outage event (~30 min, multiple retries) | 30–60 | $15–$50 |
| Sustained outage without cross-run debounce | 80–200+ | $40–$150+ |

The 90 s in-run debounce already filters most Cloudflare flakes. The remaining cost-cap measure is a cross-run debounce — see Stretch goals.

---

## Security considerations (public repo)

The repo is public so GitHub Actions runs at $0. That decision creates obligations:

### What lives in this repo and is safe to publish

- Test selectors, URLs, product slugs — already exposed via the live sites.
- The diagnose prompt's references to plugins (`woo-fly-cart`, `wpc-ajax-add-to-cart`) and the WP→Shopify bridge — same info is observable from the live HTTP responses and `wappalyzer`-style fingerprinting.
- The Shopify checkout host (`nama-cbd.myshopify.com`, `www.namacbd.com/checkouts/...`) — visible in the redirect chain to any visitor who clicks "Checkout".

### What must NEVER land in the repo

- API keys (`ANTHROPIC_API_KEY`), Slack webhook URLs, Shopify Admin tokens, WP admin credentials. All sensitive values live in **GitHub Secrets** and are passed to the runner via `env:` blocks at step granularity.
- Test artifacts that capture authenticated state. The current tests are unauthenticated, so traces and screenshots are safe to publish. **If a future test logs into wp-admin or hits authenticated pages, scrub auth headers / cookies from traces before merging — or move the repo private.**
- Anything from the WP repo's `RECON.md`. That file contains internal selectors, plugin versions, ACF field names, and the architecture map. It belongs in the (private) WP repo only.

### Hardening that is in place

- `permissions: contents: read` at the workflow top-level — the `GITHUB_TOKEN` cannot push, comment, or modify the repo even if a step is compromised.
- No use of `pull_request_target`. PR runs from forks do **not** receive secrets, so a malicious fork cannot exfiltrate `ANTHROPIC_API_KEY` or `SLACK_WEBHOOK_URL` by submitting a PR. Don't add `pull_request_target` without thinking carefully.
- GitHub's secret-scanning push protection is enabled by default for public repos — pushes containing recognised secret patterns are blocked. This is a safety net, not a substitute for review.

### Operational hygiene

- **Slack webhook rotation:** webhooks are bearer tokens for the channel they post to. If a webhook ever appears in a chat transcript, screenshot, paste, or accidental commit, rotate it in Slack admin (`Apps → Incoming Webhooks → regenerate`) and update the secret.
- **Storefront API token (in the WP repo, not here):** Shopify Storefront tokens are public-by-design — they are scoped to `unauthenticated_*` operations and cannot read customer or order data. Even so, regenerate it via Shopify admin if you suspect rate-limit abuse.
- **Slack member IDs:** the `SLACK_MENTION_USER_IDS` variable is visible in workflow logs after a failed run. IDs alone don't grant access to anything, but they enable targeted Slack phishing — keep the list to people who should actually be on-call.
- **Collaborators:** anyone with write access to the repo can trigger `workflow_dispatch` and run code with the secrets attached. Audit collaborators periodically; remove ex-employees promptly.
- **Dependabot:** keep it on. Playwright and the Claude SDK are both active codebases; CVEs in transitive deps surface fast.

### Threat model summary

| Threat | Status |
|---|---|
| Anonymous reader learns the funnel architecture | Acceptable — same info is in the live HTML |
| Anonymous PR exfiltrates secrets | **Blocked** — fork PRs don't receive secrets |
| Compromised collaborator runs malicious step | Possible — mitigated by collaborator audit |
| Webhook leaks via accidental commit | Caught by push protection; assume **not** infallible |
| Plugin CVE disclosure helps attacker | Marginal risk — info is publicly fingerprinable anyway |
| Failure trace leaks auth state | Currently safe (no auth in tests); revisit if tests change |

---

## Definition of Done (current state)

- [x] `RECON.md` filled in the WP repo (private)
- [x] `nama-monitor` repo public, pushed
- [x] Tests pass locally and in CI
- [x] `bypassPermissions` set on the Claude Agent SDK so the diagnose can navigate
- [x] Cloudflare Bot Fight Mode mitigation via `applyStealth`
- [x] Failure alert mentions on-call via `SLACK_MENTION_USER_IDS`
- [x] Success heartbeat on full e2e + manual dispatches
- [x] Workflow runs with read-only `GITHUB_TOKEN`
- [x] In-run debounce — failed runs re-attempt after 90 s before alerting
- [x] Diagnose timeout + fallback alert — on-call always receives a Slack message on double-failure, even if the AI step crashes
- [x] Cloudflare-challenge classifier — runs that fail purely because Cloudflare blocked the runner are suppressed (no alert, run marked green)
- [ ] Failure drill — break a selector on a branch, confirm Slack alert is readable and actionable
- [ ] BetterStack / UptimeRobot configured externally (not in this repo)

---

## Stretch goals

1. **Relocate runner to a VPS** with a residential-like IP. Eliminates Cloudflare bot risk, eliminates GH Actions cron drift (5–15 min in peak hours).
2. **Cross-run debounce:** the in-run 90 s debounce already filters most Cloudflare flakes. For sustained outages, the diagnose currently still fires on every double-failed run. Cap to once per outage by reading prior-run state from a small KV (Upstash, Cloudflare KV) or a job artifact.
3. **Pixel checks:** `window.fbq` and `dataLayer` assertions on PDP and post-checkout — catches silent Pixel breakage (consent banner change, GTM update) that doesn't impact the funnel for humans but kills Meta-side conversion attribution.
4. **Ad-specific landing page tests:** the top Meta/Google Ads landing URLs added as smoke checks. They're what's actually losing money when broken.
5. **Status dashboard:** static page on GitHub Pages with the last N runs and outcome history.

---

## Repo layout

```
nama-monitor/
├── .github/workflows/monitor.yml   # cron schedule + steps
├── tests/
│   ├── utils.ts                    # age-gate bypass + applyStealth
│   └── funnel.spec.ts              # smoke + e2e specs for both sites
├── scripts/
│   ├── diagnose.mjs                # Claude + Playwright MCP, runs on double-failure (8 min internal timeout)
│   ├── notify-diagnose-failed.mjs  # Fallback Slack alert if diagnose itself crashes/times out
│   └── notify-success.mjs          # Slack heartbeat, runs on full e2e success
├── playwright.config.ts
├── tsconfig.json
└── package.json
```
