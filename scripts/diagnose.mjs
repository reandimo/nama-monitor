import { query } from '@anthropic-ai/claude-agent-sdk';
import fs from 'node:fs';

const ctx = fs.existsSync('results.json')
  ? fs.readFileSync('results.json', 'utf-8').slice(0, 10_000)
  : 'no context';

const SITES = ['https://heynama.com', 'https://getnama.com'];

// Model is configurable via CLAUDE_MODEL env var. Default: Sonnet 4.6 (balanced
// cost/quality for browser-driven diagnosis). Other valid values:
//   claude-haiku-4-5  → cheaper/faster, may miss subtle clues
//   claude-opus-4-7   → highest quality, ~5x cost vs Sonnet
const MODEL = process.env.CLAUDE_MODEL ?? 'claude-sonnet-4-6';

// Cap diagnose wall-clock so we still post a Slack message before the workflow
// timeout cancels the job. Without this, when Cloudflare keeps challenging
// Playwright MCP the script burns through turns and dies silently.
const TIMEOUT_MS = 8 * 60 * 1000;

console.log(`Using model: ${MODEL} (timeout ${TIMEOUT_MS / 1000}s)`);

const ac = new AbortController();
const timeoutHandle = setTimeout(() => ac.abort(), TIMEOUT_MS);

let report = '';
let timedOut = false;
let failedReason = '';

try {
  for await (const msg of query({
    prompt: `URGENT: the Nama funnel E2E test failed. Meta Ads and Google Ads are actively spending money on these sites:
${SITES.join(', ')}

Test output:
${ctx}

Stack context (important for diagnosis):
- WordPress + WooCommerce + custom block theme "nama".
- Age gate: a modal on the home and PDP that is dismissed by writing localStorage 'nama_age_verified' = '1'. The test already bypasses it via addInitScript.
- Cart: "WPC Fly Cart" plugin (woofc_*). Add-to-Cart success is measured by increment of [data-cart-fragment="cart-count"].
- Checkout: when the user clicks /checkout/, WordPress redirects to the Shopify checkout via the Storefront API. The valid destination is either https://nama-cbd.myshopify.com/checkouts/... or the branded domain https://www.namacbd.com/checkouts/... — both are OK. THIS BRIDGE IS THE MOST FRAGILE PART OF THE FUNNEL.
- Test product: /product/the-ultimate-nama-sampler/.
- Cloudflare Bot Fight Mode (managed by Cloudways) often challenges GitHub Actions IPs even with stealth. If you encounter persistent challenge pages, STOP early — that is informative on its own and worth reporting fast.

Tasks (be efficient — you have a hard ${TIMEOUT_MS / 1000}s wall-clock budget):
1. Visit each domain. Dismiss the age gate (button with selector data-age-gate-yes, label "Yes, I'm at least 21") if it appears. If you hit a Cloudflare challenge page, abort browser checks immediately and report "Cloudflare blocking runner".
2. Go to /product/the-ultimate-nama-sampler/, click Add to Cart.
3. Visit /checkout/. Confirm whether the browser lands on a valid Shopify URL (nama-cbd.myshopify.com/checkouts/... or www.namacbd.com/checkouts/...) without an error, or whether it breaks along the way.
4. Identify EXACTLY at which step the funnel breaks on each domain (one may break while the other still works).
5. Most likely cause — consider especially:
   - Cloudflare/WAF blocking GitHub Actions IPs (most common false positive — symptom: challenge page, weird HTML)
   - 5xx on heynama/getnama (hosting or WordPress down)
   - JS error on home or PDP (browser console)
   - Product out of stock or slug changed
   - Cart plugin (woo-fly-cart, wpc-ajax-add-to-cart) auto-updated and broke the button or the fragments
   - Shopify bridge broken: Storefront token expired/rotated, product missing shopify_id ACF field, invalid selling plan ID, deprecated GraphQL schema
   - Shopify returns an error on its checkout (empty cart, product disabled on the Shopify side, geo-block)
6. Severity: is the Ads funnel broken (purchase impossible) or just cosmetic?

Respond in English, in exactly this format:
- 🔴/🟡 SEVERITY
- DOMAIN affected: heynama / getnama / both
- STEP that fails (home / PDP / add-to-cart / redirect to Shopify / Shopify checkout)
- LIKELY CAUSE (be specific — point to a plugin, a token, a concrete selector)
- SUGGESTED ACTION (e.g. roll back woo-fly-cart, regenerate Storefront token in Shopify.php, restock product, contact hosting)`,
    options: {
      model: MODEL,
      mcpServers: {
        playwright: { command: 'npx', args: ['@playwright/mcp@latest', '--headless'] },
      },
      maxTurns: 15,
      permissionMode: 'bypassPermissions',
      abortController: ac,
    },
  })) {
    if (msg.type === 'result') report = msg.result;
  }
} catch (err) {
  if (ac.signal.aborted) {
    timedOut = true;
  } else {
    failedReason = err instanceof Error ? err.message : String(err);
  }
} finally {
  clearTimeout(timeoutHandle);
}

const userIds = (process.env.SLACK_MENTION_USER_IDS ?? process.env.SLACK_MENTION_USER_ID ?? '')
  .split(/[\s,]+/)
  .filter(Boolean);

const mention = userIds.length ? userIds.map((id) => `<@${id}>`).join(' ') + ' ' : '';

let text;
if (report) {
  const partialNote = timedOut ? '\n\n_⚠️ Diagnosis truncated — wall-clock timeout reached. Conclusions may be incomplete._' : '';
  text = `${mention}🚨 *NAMA FUNNEL DOWN* 🚨\n_Meta/Google Ads still spending_\n\n${report}${partialNote}`;
} else if (timedOut) {
  text = `${mention}🚨 *NAMA FUNNEL DOWN* 🚨\n_Meta/Google Ads still spending_\n\n` +
    `Tests failed twice but the AI diagnose timed out after ${TIMEOUT_MS / 1000 / 60} min before producing a verdict. ` +
    `Most common cause: Cloudflare bot challenge keeping the runner from reaching the site.\n\n` +
    `*Manual check (60 sec):* open https://heynama.com from mobile data (not VPN/office). ` +
    `If it loads → likely Cloudflare false positive, funnel is fine for users. ` +
    `If it doesn't → real outage, pause ad spend.`;
} else {
  text = `${mention}🚨 *NAMA FUNNEL DOWN* 🚨\n_Meta/Google Ads still spending_\n\n` +
    `Tests failed twice and the AI diagnose script crashed: ${failedReason || 'unknown error'}.\n\n` +
    `*Manual check required* — verify https://heynama.com loads from mobile data.`;
}

const webhook = process.env.SLACK_WEBHOOK_URL;
if (!webhook) {
  console.error('SLACK_WEBHOOK_URL is not set — the report will not be published.');
  console.log(text);
  process.exit(1);
}

const res = await fetch(webhook, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ text, link_names: 1 }),
});

if (!res.ok) {
  console.error(`Slack returned ${res.status}: ${await res.text()}`);
  process.exit(1);
}

console.log(text);
process.exit(0);
