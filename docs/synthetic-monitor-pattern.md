# Synthetic Funnel Monitor — Architecture Brief

> Self-contained reference for implementing a similar monitor in a different repo/domain.
> Describes the pattern, decisions, and gotchas — not the specifics of any one site.

---

## Problem this solves

Sites that run paid ads (Meta, Google, etc.) need automated detection when the purchase funnel breaks. Every minute of silent breakage is wasted ad spend. Standard uptime monitors (200 OK on the homepage) don't catch the cases that matter: "page loads but Add-to-Cart button vanished", "checkout redirect to payment provider broken", "AJAX fragment never updates", and similar UX-only breakages.

This is a **synthetic E2E monitor** that walks the full purchase funnel every 15–30 min on a schedule. When it breaks, an AI agent investigates the live site and posts a structured Slack alert with root cause and suggested fix.

---

## Three-layer architecture

| Layer | Tool | Cadence | Purpose |
|---|---|---|---|
| 1. Sub-minute uptime | External (BetterStack, UptimeRobot, etc.) | every 1 min | Detect "site is unreachable" — **NOT** part of this repo |
| 2. Funnel correctness | Playwright in GitHub Actions | 15 / 30 min | Walk the funnel; this is the main component |
| 3. Failure diagnosis | Claude Agent SDK + Playwright MCP | only on failure | Investigate live site, identify root cause, post to Slack |

Layer 1 is a hard recommendation, not a build — GitHub Actions cron has 5–15 min drift in peak hours, so this monitor is **not** real-time uptime.

---

## Test design pattern

Two test tiers running against all target sites in parallel:

- **Smoke (every 15 min):** homepage + critical interior page load with HTTP < 400, primary CTA visible. Cheap, fast (~10s).
- **Full e2e (every 30 min):** smoke + the actual funnel action (add to cart, click checkout, assert payment provider redirect). The "100% works for users" check.

Both tiers run against multiple sites with a single spec file:

```typescript
for (const site of SITES) {
  test.describe(site.name, () => {
    test('smoke: …', async ({ page }) => { … });
    test('e2e: …', async ({ page }) => { … });
  });
}
```

Schedule is split into two crons; a `Decide scope` step in the workflow reads `github.event.schedule` to set a `--grep smoke` filter when the smoke cron fires.

---

## Resilience patterns

### 1. In-run debounce (suppress single-shot flakes)

When tests fail, the workflow sleeps **90s** and re-runs **once**. Alerts only fire if BOTH attempts fail. Filters out the single most common false positive: edge / CDN / bot-protection flakes that clear within 1–3 min.

### 2. Bot-challenge classifier (suppress IP-block noise)

GitHub Actions runners use datacenter IPs that bot protection (Cloudflare, Akamai, AWS WAF, etc.) sometimes blocks. We don't want to alert when the runner itself is being blocked — that's noise, not actionable.

Pattern: in `test.afterEach`, on any failure, inspect the page state for known bot-challenge fingerprints (URL pattern, document title, body text). Write detected challenges to a log file. After the retry, the workflow compares total failures vs challenge-detected failures. If **all failures were challenges**, suppress the alert AND mark the workflow run green (clean history; alert only when actionable).

Critical: detection has to be on the **page state at failure time**, not from logs after the fact. Fingerprints we used for Cloudflare:

| Signal | Pattern |
|---|---|
| URL | `cdn-cgi/challenge-platform`, `__cf_chl_` |
| Document title | `Just a moment`, `Attention required`, `Cloudflare` |
| Body text | `Verifying you are human`, `Cloudflare Ray ID` |

Adapt for your provider (Akamai, AWS WAF, etc.) by inspecting what their challenge pages look like.

### 3. Bot-detection stealth (reduce challenges in the first place)

Default Playwright headless gets fingerprinted easily. Mitigations via `addInitScript` in a context-init helper:

- **Drop any custom User-Agent override.** Real Chromium default UA passes more checks than something like `MyMonitor/1.0` does.
- `navigator.webdriver` → `undefined`
- Strip `HeadlessChrome` from `navigator.appVersion` and `navigator.userAgent`
- Mock `window.chrome`, populate `navigator.plugins`, `navigator.languages`
- Patch the `permissions.query` notifications quirk

This is a stopgap — provider detection improves over time. Durable fix is to relocate the runner to a VPS with a residential-like IP.

---

## Failure diagnose pattern (the "AI on failure" piece)

When both attempts fail and the failures aren't all bot challenges, fire a Node script that uses the **Claude Agent SDK + Playwright MCP** to investigate the live site.

The script:

1. Reads the Playwright `results.json` to know which tests failed and how.
2. Prompts Claude with: a stack context (what plugins / frameworks / integrations are in the funnel), the test output, and a structured "go investigate" task.
3. **Critical SDK options:**
   - `mcpServers: { playwright: { command: 'npx', args: ['@playwright/mcp@latest', '--headless'] } }`
   - `permissionMode: 'bypassPermissions'` — **required** for unattended CI; otherwise the agent gets stuck asking permission for every browser action
   - `maxTurns: 15` — beyond this, more turns rarely converge. Fail fast.
   - `model: 'claude-sonnet-4-6'` (or configurable via env var) — Sonnet is the cost/quality sweet spot for browser-driven investigation. Haiku is ~5x cheaper but misses subtler clues; Opus is ~5x more expensive and overkill for most failures.
4. **AbortController with 8-min wall-clock timeout** wrapping the SDK query. The diagnose CAN get stuck fighting bot protection itself; the timeout ensures it always returns a partial-or-fallback message rather than hanging until the job timeout.
5. Posts the result to Slack with optional `@mentions` from a `SLACK_MENTION_USER_IDS` env var (supports multiple comma/space-separated IDs).

---

## Slack output (three message types)

1. **Success heartbeat** — posted only on full-e2e success and manual `workflow_dispatch`. Smoke runs are silent (too noisy at 96/day). Optional separate webhook (`SLACK_WEBHOOK_URL_SUCCESS`) routes heartbeats to a different channel from alerts.
2. **Full diagnosis (on real failure)** — the AI's structured report with `@mentions`, tagged with a critical emoji + "X still spending money" header to convey urgency.
3. **Fallback minimal alert** — if the diagnose script itself crashes or hits its step-level timeout, a final workflow step posts a one-liner pointing to the workflow run, asking for manual verification. Guarantees the on-call always sees SOMETHING on a real failure.

---

## Defense in depth on the alert pipeline

Four nested timeouts ensure the system fails safely without hanging or going silent:

| Layer | Limit | Behavior |
|---|---|---|
| `AbortController` inside diagnose script | 8 min | Posts partial / fallback message |
| Step-level `timeout-minutes: 9` | 9 min | Step marked failed; fallback step takes over |
| Fallback Slack step | — | Posts minimal alert via webhook directly |
| Job-level `timeout-minutes: 20` | 20 min | Last resort; should never be reached |

---

## Workflow shape

Single workflow file. Steps in order:

```
checkout → setup-node + cache → npm ci → playwright install →
decide scope → run tests → debounce re-run →
classify (real vs bot-challenge) → diagnose with AI →
fallback alert → notify success → upload artifacts → fail step
```

Each conditional step gates on `steps.<id>.outcome` of the previous ones. The final `Fail` step is what marks the run red — gated on "both attempts failed AND classifier says not all bot-challenge".

---

## Permissions hardening (do this if going public)

- `permissions: contents: read` at the workflow top-level. The default token can't push or modify the repo even if a step is compromised.
- All secrets in GitHub Secrets, never in code. Verify push-protection is active for the repo.
- **No `pull_request_target`.** Default `pull_request` workflows from forks do not receive secrets — keep it that way.
- Branch protection rules requiring PR before merging to main, ideally with "Required approvals: 0" for solo dev (gate but not blocker, since GitHub blocks self-approval).
- Branch ruleset bypass set to "For pull requests only" instead of "Always allow", so admin bypasses other rules but still must go through PR (closes self-account-compromise vector).

---

## Cost model

| Item | Cost |
|---|---|
| GitHub Actions on **public** repo | $0, unlimited Linux minutes |
| GitHub Actions on **private** repo at default cadence | ~$80/month (mitigated by browser-cache, lower cadence, or VPS) |
| AI diagnose (Sonnet 4.6 default), healthy month | **~$5–$25** |
| AI diagnose, sustained outage without cross-run debounce | up to $150 worst case |

---

## Key decisions to think about for a new repo

1. **What "the funnel" is for that site** — what's the equivalent of add-to-cart + checkout-redirect? That's the spec to write.
2. **What "transient flake" looks like** — for the original implementation, that was Cloudflare. For your site it might be rate limiting, geo redirects, A/B test variants. Add detection in `afterEach` and gate alerts accordingly.
3. **Is checkout on the same domain or a redirect to a third-party?** Most SaaS / commerce funnels redirect — assertions need to be redirect-aware (URL pattern check, not host equality).
4. **What's the lowest-friction failure signal?** Structural signals (DOM element with a stable data-attribute, counter increment, network response) are more robust than text-based ones (notification messages, error banners) because plugins suppress / change them between releases.
5. **Where does sensitive state live?** If tests authenticate, scrub auth headers from Playwright traces before publishing them — or keep the repo private.

---

## What NOT to do (lessons learned)

- ❌ **Don't set a bot-looking User-Agent.** Real Chromium default UA passes more checks than `MyMonitor/1.0` does. Provider bot lists target obvious bot strings.
- ❌ **Don't rely on a single CSS notification text** for funnel-step success. Plugins suppress / change notifications between releases. Use a structural signal instead.
- ❌ **Don't fire the AI diagnose on every single failure.** A 90s debounce filters ~70%+ of flakes. Without it, AI cost balloons during transient issues.
- ❌ **Don't let the AI diagnose hang indefinitely** waiting for tool permissions. Set `permissionMode: 'bypassPermissions'` in unattended CI; you will run out of job-time otherwise.
- ❌ **Don't run scheduled workflows on a fork** — GitHub disables them. Keep the repo as a standalone repo, not a fork.
- ❌ **Don't paste secrets in chat or logs** — even with push protection, secrets in transcripts / screenshots are leaked. Rotate immediately if exposed.
- ❌ **Don't alert when the runner itself is blocked.** Suppress those alerts (classifier pattern) — they're noise. The risk that 100% of runs get blocked silently is mitigated by the absent-heartbeat signal documented in the team runbook.

---

## File / step inventory (the original implementation)

```
.github/workflows/monitor.yml       # cron schedule + all steps
tests/
  utils.ts                          # stealth + bot-challenge detection + age-gate or similar
  funnel.spec.ts                    # smoke + e2e specs, afterEach hook for CF logging
scripts/
  diagnose.mjs                      # Claude + Playwright MCP, with AbortController
  notify-diagnose-failed.mjs        # fallback Slack post when diagnose itself crashes
  notify-success.mjs                # heartbeat on full e2e success
playwright.config.ts                # default Chromium config; no custom UA
package.json                        # @playwright/test, @anthropic-ai/claude-agent-sdk, @playwright/mcp
```

Total: ~7 source files, ~400 lines of code including tests.

---

## Adapting to a new repo — checklist

1. Replace site URLs, product/funnel slugs, and selectors in `tests/funnel.spec.ts`.
2. Update the stack context paragraph in the diagnose prompt to describe the new site's tech (CMS, plugins, payment provider, etc.) — this is what gives Claude the priors to make good guesses.
3. Verify the bot-challenge fingerprints match your CDN/WAF. If different provider, replace the regex set in `tests/utils.ts`.
4. Set GH Secrets (`ANTHROPIC_API_KEY`, `SLACK_WEBHOOK_URL`, optionally `SLACK_WEBHOOK_URL_SUCCESS`) and Variables (`CLAUDE_MODEL`, `SLACK_MENTION_USER_IDS`).
5. Push, run `gh workflow run` to validate manually before relying on cron.
6. Do a failure drill: break a selector on a branch, push, confirm the alert lands and is actionable. Revert.
7. Consider an external uptime monitor (BetterStack / UptimeRobot) as a complement for sub-minute detection.
