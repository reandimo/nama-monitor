# Nama Funnel Monitor — Team Overview

> One-page handoff for anyone who'll receive alerts, triage incidents, or want to understand what this thing does. Paste into Notion as-is.

---

## Why this exists

We run paid Meta and Google Ads driving traffic to **heynama.com** and **getnama.com**. When the purchase funnel silently breaks (Add-to-Cart button missing, checkout redirect failing, etc.), ad budget keeps spending while zero conversions come through.

This monitor automates the detection and triage:

- Runs the full purchase funnel against both sites on a schedule, every 15–30 minutes.
- When something breaks, an AI agent investigates the live site (navigates, screenshots, reads console errors) and posts a Slack alert with a likely cause and a suggested fix.
- The on-call engineer gets pinged so action can happen before more ad spend burns.

---

## What it watches

| Check | Cadence | What it does |
|---|---|---|
| **Smoke** | every 15 min | Confirms home page and product page load + the Add-to-Cart button is visible on both domains |
| **Full e2e** | every 30 min | Smoke checks + adds a product to cart, clicks checkout, confirms the user is redirected to a valid Shopify checkout page |

Both sites get the same checks. The full e2e specifically verifies the **WordPress → Shopify** bridge, which is the most fragile part of the stack.

---

## What you'll see in Slack

Three types of messages, all in the configured alert channel:

### 1. ✅ Heartbeat — *every 30 min, only on success*

```
✅ Nama funnel healthy — full e2e
4/4 passed in 30.5s

✅ funnel.spec.ts › heynama › smoke: home + product page load
✅ funnel.spec.ts › heynama › e2e: add to cart and redirect to Shopify checkout
✅ funnel.spec.ts › getnama › smoke: home + product page load
✅ funnel.spec.ts › getnama › e2e: add to cart and redirect to Shopify checkout
```

**Means:** The funnel is healthy. Nothing to do — it's a periodic confirmation that the monitor itself is alive.

If you go more than an hour without seeing a heartbeat, the monitor itself may be broken (separate from the funnel being broken).

### 2. 🚨 Full diagnosis — *funnel broke twice in a row, AI investigated*

```
@on-call 🚨 NAMA FUNNEL DOWN 🚨
Meta/Google Ads still spending

🔴 SEVERITY: CRITICAL — Ads funnel is 100% broken.
DOMAIN affected: BOTH — heynama and getnama.
STEP that fails: PDP — Add-to-Cart button not visible.
LIKELY CAUSE: WPC Fly Cart plugin auto-updated and changed the
button selector. Verified by inspecting the live PDP HTML where
.single_add_to_cart_button is no longer rendered.
SUGGESTED ACTION: 1) WP admin → Plugins → roll back WPC Fly Cart
to previous version; 2) once button returns, re-run the workflow
to confirm green.
```

**Means:** This is real. Tests failed twice (so it's not a Cloudflare flake), and the AI inspected the live site to identify the root cause.

**Action:** read the **SUGGESTED ACTION**, do it, then re-run the workflow to confirm.

### 3. 🚨 Manual check needed — *AI investigation didn't complete (rare)*

```
@on-call 🚨 NAMA FUNNEL DOWN 🚨
Meta/Google Ads still spending

Tests failed twice but the AI diagnose timed out before producing
a verdict.

Manual check (60 sec): open https://heynama.com from mobile data
(not VPN/office). If it loads → likely transient, monitor and
re-run. If it doesn't → real outage, pause ad spend.
```

**Means:** the AI tried to investigate but got cancelled or crashed before producing a verdict. With the Cloudflare classifier in place, this is now rare.

**Action:** verify in 60 seconds on your phone, on mobile data (not office wifi or VPN). If the site loads, you can ignore the alert and check back at the next scheduled run. If it doesn't, treat it as a real outage.

### Suppressed: Cloudflare-only blocks

Sometimes the test runner gets blocked by Cloudflare's bot protection without the actual site being broken for users. The monitor detects this automatically (URL pattern, page title, body text) and **suppresses the alert**. The workflow run is marked green and Slack stays silent. There is no message to act on — the funnel is fine for real users.

If 100% of runs become CF-blocked for an extended period (no successful heartbeats for >1 hour), that's worth investigating: open the GitHub Actions tab and you'll see the runs are green but the test logs note `All N failures were Cloudflare bot challenges`. The fix is usually escalation to Cloudways to whitelist GitHub Actions IPs, or relocating the runner to a VPS.

---

## Runbook — what to do when alerts fire

### When you get a 🔴 CRITICAL alert

1. **First 60 seconds — verify it's real.** Open https://heynama.com on your phone with mobile data. If it doesn't load: real outage. If it does: probably a Cloudflare false positive (still worth investigating, but no need to pause ads).
2. **If real:** pause Meta/Google Ads spend immediately. Estimated burn rate is in the hundreds of dollars per hour.
3. **Read the SUGGESTED ACTION in the alert** and act on it — most actions are one-liners (rollback a plugin, restock a product, regenerate a token).
4. **Re-run the workflow** after the fix to confirm green: `gh workflow run "Nama Funnel Monitor"` or via the Actions tab on GitHub.
5. **If the action doesn't work or you don't understand it:** escalate to the dev owner.

### When you get a 🟡 WARNING alert

- The funnel works but something cosmetic broke (e.g. wrong product price displayed, broken image).
- Investigate during business hours. **No need to pause ads.**

### When you get a "Manual check needed" alert

- Open the site on mobile data (60 seconds).
- If it loads: ignore — this is a Cloudflare false positive.
- If it doesn't: treat as a 🔴 CRITICAL.

### When you don't see the heartbeat in over an hour

- The monitor itself is down, not the funnel.
- Check the GitHub Actions tab for failures in the workflow setup steps (npm install, browser install).
- The funnel may still be fine — but for now you have no automated visibility, so verify manually.

---

## Verifying the monitor is healthy

- **Slack:** ✅ heartbeat appears every 30 minutes.
- **GitHub Actions tab:** the "Nama Funnel Monitor" workflow shows recent green runs.
- **Manual run:** click "Run workflow" on the Actions page (or `gh workflow run "Nama Funnel Monitor"`). A green run within 2 minutes confirms everything is wired up.

---

## Cost

| Item | Cost |
|---|---|
| GitHub Actions | $0 (public repo, unlimited minutes) |
| AI diagnose runs (Claude API) | ~$5–$40/month under healthy conditions, up to ~$150 in a sustained outage month |

Cost scales with **how often the funnel breaks**, not with how often we run the tests. A perfectly healthy month is the cheapest.

---

## Caveats — known limits

1. **Detection is not real-time.** Worst case ~30 minutes from breakage to alert (15 min smoke cadence + 90 s debounce + ~5 min run time). For sub-minute detection we'd need an external uptime service like BetterStack — not yet set up.
2. **Cloudflare false positives.** The test runner uses GitHub-hosted IPs that Cloudflare's bot protection sometimes flags. We've added stealth measures and a debounce, but ~5% of alerts may still be false positives. The "manual check" runbook step handles this.
3. **No purchase flow tested.** The monitor verifies the funnel up to and including the Shopify checkout redirect, but it does **not** complete a purchase (would mess with inventory and rack up test transactions). Issues purely on the Shopify side that prevent payment completion would not be caught.
4. **Pixel / conversion tracking not checked.** It's possible for the funnel to work correctly for humans while the Meta Pixel breaks, leading to silent attribution loss. A future iteration will add Pixel checks.

---

## Ownership and links

| | |
|---|---|
| Code repository | `github.com/[your-username]/nama-monitor` (public) |
| Slack alert channel | `#[channel-name]` |
| On-call (gets @mentioned on alerts) | configured in the repo's `SLACK_MENTION_USER_IDS` variable |
| Owner | **[name]** |
| Last updated | 2026-04-27 |

---

## FAQ

**Q: I muted the alert channel — will I still get pinged?**
A: Yes. Direct `@mentions` break through channel mute in default Slack notification settings. If you've also disabled mention notifications, you won't.

**Q: I got a 🚨 alert but the site looks fine to me. False alarm?**
A: With the Cloudflare classifier in place, this should rarely happen. When it does, it usually means the AI partially diagnosed something cosmetic. Verify on mobile data — if the site loads and the funnel works, the issue is likely real but minor (e.g. a wrong selector that affects monitoring but not real users). Worth flagging to the dev owner anyway.

**Q: I haven't seen a heartbeat in over an hour. What gives?**
A: Either the funnel is failing repeatedly with non-CF errors (you'd be getting alerts) or the runner is being blocked by Cloudflare on every attempt (alerts suppressed silently). Open the GitHub Actions tab — if you see a string of green runs but they all log "All N failures were Cloudflare bot challenges", that's the second case. Escalate to the dev owner; the fix is on the infrastructure side.

**Q: How long does it take to detect a real outage?**
A: Up to 30 minutes worst case, usually 15. We can reduce this by pairing with an external uptime monitor (sub-minute detection) — recommended but not yet set up.

**Q: Can I run a check manually right now?**
A: Yes. GitHub → Actions tab → "Nama Funnel Monitor" → "Run workflow". A result lands in Slack within ~2 minutes.

**Q: How do I add another person to the on-call mentions?**
A: Get their Slack member ID (Slack profile → ⋯ → Copy member ID) and ask the dev owner to add it to the `SLACK_MENTION_USER_IDS` variable in the repo settings. Multiple IDs can be space-separated.

**Q: What does the monitor cost the company?**
A: ~$5–$40/month in normal operation. The infrastructure (GitHub Actions) is free; only the AI investigation on failures costs money. The cost goes up only when things break.

**Q: How are we sure the monitor itself isn't lying?**
A: Three layers of self-checks:
1. Every 30-min heartbeat confirms the monitor itself is alive.
2. Every alert has a workflow run link so you can see exactly what was tested and what the response looked like (HTML, screenshots, console logs).
3. The repository is public — anyone can audit the test code, the AI prompt, and the alert templates.
