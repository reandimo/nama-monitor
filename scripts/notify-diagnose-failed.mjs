// Last-resort Slack alert when the AI diagnose step itself fails to complete
// (job-level timeout, OOM, network error before scripts/diagnose.mjs could
// post). Posts a minimal message so the on-call still gets notified.

const userIds = (process.env.SLACK_MENTION_USER_IDS ?? process.env.SLACK_MENTION_USER_ID ?? '')
  .split(/[\s,]+/)
  .filter(Boolean);

const mention = userIds.length ? userIds.map((id) => `<@${id}>`).join(' ') + ' ' : '';

const runUrl = process.env.GITHUB_SERVER_URL && process.env.GITHUB_REPOSITORY && process.env.GITHUB_RUN_ID
  ? `${process.env.GITHUB_SERVER_URL}/${process.env.GITHUB_REPOSITORY}/actions/runs/${process.env.GITHUB_RUN_ID}`
  : null;

const text = `${mention}🚨 *NAMA FUNNEL DOWN* 🚨
_Meta/Google Ads still spending_

Tests failed twice in a row but the AI diagnose did not complete (timeout or crash). Verify manually before reacting:

1. Open https://heynama.com from *mobile data* (not VPN/office wifi).
2. If it loads normally → most likely a Cloudflare bot challenge against GH Actions. The funnel is fine for real users.
3. If it does NOT load → real outage. Pause Meta/Google Ads spend and contact Cloudways.
${runUrl ? `\nWorkflow run: ${runUrl}` : ''}`;

const webhook = process.env.SLACK_WEBHOOK_URL;
if (!webhook) {
  console.error('SLACK_WEBHOOK_URL is not set.');
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
