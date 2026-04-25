import { query } from '@anthropic-ai/claude-agent-sdk';
import fs from 'node:fs';

const ctx = fs.existsSync('results.json')
  ? fs.readFileSync('results.json', 'utf-8').slice(0, 10_000)
  : 'no context';

const SITES = ['https://heynama.com', 'https://getnama.com'];

let report = '';
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

Tasks:
1. Visit each domain. Dismiss the age gate (button with selector data-age-gate-yes, label "Yes, I'm at least 21") if it appears.
2. Go to /product/the-ultimate-nama-sampler/, click Add to Cart.
3. Visit /checkout/. Confirm whether the browser lands on a valid Shopify URL (nama-cbd.myshopify.com/checkouts/... or www.namacbd.com/checkouts/...) without an error, or whether it breaks along the way.
4. Identify EXACTLY at which step the funnel breaks on each domain (one may break while the other still works).
5. Most likely cause — consider especially:
   - 5xx on heynama/getnama (hosting or WordPress down)
   - JS error on home or PDP (browser console)
   - Product out of stock or slug changed
   - Cart plugin (woo-fly-cart, wpc-ajax-add-to-cart) auto-updated and broke the button or the fragments
   - Shopify bridge broken: Storefront token expired/rotated, product missing shopify_id ACF field, invalid selling plan ID, deprecated GraphQL schema
   - Shopify returns an error on its checkout (empty cart, product disabled on the Shopify side, geo-block)
   - Cloudflare/WAF blocking GitHub Actions IPs (symptom: weird HTML, challenge page)
6. Severity: is the Ads funnel broken (purchase impossible) or just cosmetic?

Respond in English, in exactly this format:
- 🔴/🟡 SEVERITY
- DOMAIN affected: heynama / getnama / both
- STEP that fails (home / PDP / add-to-cart / redirect to Shopify / Shopify checkout)
- LIKELY CAUSE (be specific — point to a plugin, a token, a concrete selector)
- SUGGESTED ACTION (e.g. roll back woo-fly-cart, regenerate Storefront token in Shopify.php, restock product, contact hosting)`,
  options: {
    mcpServers: {
      playwright: { command: 'npx', args: ['@playwright/mcp@latest', '--headless'] },
    },
    maxTurns: 30,
  },
})) {
  if (msg.type === 'result') report = msg.result;
}

const text = `🚨 *NAMA FUNNEL DOWN* 🚨\n_Meta/Google Ads still spending_\n\n${report}`;

const webhook = process.env.SLACK_WEBHOOK_URL;
if (!webhook) {
  console.error('SLACK_WEBHOOK_URL is not set — the report will not be published.');
  console.log(report);
  process.exit(1);
}

await fetch(webhook, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ text, link_names: 1 }),
});
console.log(report);
