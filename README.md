# nama-monitor

Synthetic funnel monitor for [heynama.com](https://heynama.com) and [getnama.com](https://getnama.com). Runs Playwright E2E tests on a schedule via GitHub Actions and sends Slack alerts with an AI-powered diagnosis when something breaks.

## What it checks

| Job | Cadence | What it does |
|---|---|---|
| **Smoke** | every 15 min | Homepage + product page load, key UI elements visible |
| **Full e2e** | every 30 min | Smoke + add-to-cart + checkout redirect to Shopify |

Failed runs are automatically retried once after 90 seconds. Alerts only fire on confirmed double-failures. Cloudflare bot-challenge flakes are detected and suppressed.

## Local development

```bash
npm install
npx playwright install --with-deps chromium
npm run test:smoke   # smoke only (~10s)
npm test             # full e2e (~30s, hits live sites)
```

Local runs hit production. They don't fill checkout forms or place orders.

## Repo layout

```
nama-monitor/
├── .github/workflows/monitor.yml   # cron schedule + steps
├── tests/
│   ├── utils.ts                    # stealth helpers
│   └── funnel.spec.ts              # smoke + e2e specs
├── scripts/
│   ├── diagnose.mjs                # AI diagnosis on failure
│   ├── notify-diagnose-failed.mjs  # fallback alert
│   └── notify-success.mjs          # success heartbeat
├── playwright.config.ts
├── tsconfig.json
└── package.json
```
