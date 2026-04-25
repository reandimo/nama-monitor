import fs from 'node:fs';

const webhook = process.env.SLACK_WEBHOOK_URL_SUCCESS ?? process.env.SLACK_WEBHOOK_URL;
if (!webhook) {
  console.error('No webhook configured — skipping success notification.');
  process.exit(0);
}

if (!fs.existsSync('results.json')) {
  console.error('results.json not found — skipping success notification.');
  process.exit(0);
}

const results = JSON.parse(fs.readFileSync('results.json', 'utf-8'));
const { expected = 0, unexpected = 0, flaky = 0, duration = 0 } = results.stats ?? {};
const total = expected + unexpected + flaky;
const durationSec = (duration / 1000).toFixed(1);

function* walkSpecs(suite, parentTitle = '') {
  const here = [parentTitle, suite.title].filter(Boolean).join(' › ');
  for (const spec of suite.specs ?? []) {
    const passed = (spec.tests ?? []).every((t) =>
      (t.results ?? []).some((r) => r.status === 'passed' || r.status === 'expected')
    );
    yield { title: [here, spec.title].filter(Boolean).join(' › '), passed };
  }
  for (const child of suite.suites ?? []) {
    yield* walkSpecs(child, here);
  }
}

const tests = [];
for (const s of results.suites ?? []) {
  for (const t of walkSpecs(s)) tests.push(t);
}

const lines = tests.map((t) => `${t.passed ? '✅' : '❌'} ${t.title}`).join('\n');
const flakyNote = flaky ? ` _(${flaky} flaky — passed on retry)_` : '';
const scope = process.env.MONITOR_SCOPE === 'smoke' ? 'smoke only' : 'full e2e';
const trigger = process.env.GITHUB_EVENT_NAME === 'workflow_dispatch' ? 'manual' : scope;

const text = `✅ *Nama funnel healthy* — ${trigger}
${expected}/${total} passed in ${durationSec}s${flakyNote}

${lines}`;

const res = await fetch(webhook, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ text }),
});

if (!res.ok) {
  console.error(`Slack returned ${res.status}: ${await res.text()}`);
  process.exit(1);
}

console.log(text);
