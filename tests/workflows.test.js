'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const bundler = require('../scripts/lib/bundler');
const { runChecks, scanForSecrets, checkWorkflow, CREDENTIAL_PLACEHOLDER } = require('../scripts/check-workflows');
const {
  REPO_ROOT,
  WF01_FILE,
  WF02_FILE,
  SANDBOX_ENV,
  LIVE_ENV,
  SIGNING_SECRET,
  HUBSPOT_SECRET,
  loadWorkflow,
  loadSample,
  getNode,
  runCodeNode,
  hmacBase64,
  signSlackRequest,
  slackInteractionBody,
  blockActionsPayload
} = require('./helpers/n8n-harness');

const wf01 = loadWorkflow(WF01_FILE);
const wf02 = loadWorkflow(WF02_FILE);

test('workflows: repository checks pass (JSON, credentials, secrets, sync, sandbox gates)', () => {
  const { errors, workflowCount, moduleCount } = runChecks();
  assert.deepEqual(errors, []);
  assert.equal(workflowCount, 2);
  assert.ok(moduleCount >= 7);
});

test('workflows: every Code node bundle is byte-identical to a fresh build of src/', () => {
  for (const wf of [wf01, wf02]) {
    assert.deepEqual(bundler.syncWorkflow(wf).changedNodes, []);
  }
});

test('workflows: a hand-edited bundle is detected as out of sync', () => {
  const tampered = JSON.parse(JSON.stringify(wf01));
  const node = getNode(tampered, 'Validate & Idempotency Gate');
  node.parameters.jsCode = node.parameters.jsCode.replace("const IDEMPOTENCY_KEY_VERSION = 'v1';", "const IDEMPOTENCY_KEY_VERSION = 'v9';");
  const errors = checkWorkflow('tampered.json', tampered, [], new Set());
  assert.ok(errors.some((e) => /out of sync/.test(e)));
});

test('workflows: all credentials use the placeholder ID and workflows ship inactive', () => {
  for (const wf of [wf01, wf02]) {
    assert.equal(wf.active, false);
    const creds = wf.nodes.flatMap((n) => Object.values(n.credentials || {}));
    assert.ok(creds.length > 5);
    for (const cred of creds) assert.equal(cred.id, CREDENTIAL_PLACEHOLDER);
  }
});

test('workflows: secret scanner catches real-looking tokens (built at runtime, never committed)', () => {
  assert.deepEqual(scanForSecrets('xox' + 'b-123456789012-abcdefghijkl'), ['Slack token']);
  assert.ok(scanForSecrets('sk-' + 'proj-' + 'a'.repeat(30)).length === 1);
  assert.deepEqual(scanForSecrets('xoxb-... placeholder in docs'), []);
});

test('workflows: CommonJS stripping removes use strict, local requires and exports', () => {
  const stripped = bundler.stripCommonJs("'use strict';\nconst { a } = require('./sanitizer');\nfunction f() { return a; }\nmodule.exports = { f };\n", 'demo');
  assert.equal(stripped, 'function f() { return a; }\n');
  assert.throws(() => bundler.stripCommonJs("const fs = require('fs');\nmodule.exports = {};\n", 'bad'), /non-local require/);
  assert.throws(() => bundler.stripCommonJs('function f() {}\n', 'noexports'), /module\.exports/);
});

test('workflows: bundler resolves dependencies before dependants', () => {
  const order = bundler.resolveModuleOrder(['approval']);
  assert.ok(order.indexOf('sanitizer') < order.indexOf('idempotency'));
  assert.ok(order.indexOf('slack-blocks') < order.indexOf('approval'));
  assert.equal(order[order.length - 1], 'approval');
});

test('workflows: WF01 follows the documented node order', () => {
  const chain = ['HubSpot Deal Stage Webhook', 'Load Config', 'Verify & Extract Closed-Won Events', 'Loop Over Deals'];
  for (let i = 0; i < chain.length - 1; i += 1) {
    assert.equal(wf01.connections[chain[i]].main[0][0].node, chain[i + 1]);
  }
  assert.equal(wf01.connections['Validate & Idempotency Gate'].main[0][0].node, 'Proceed?');
  assert.equal(wf01.connections['Slack: Post Approval Gate'].main[0][0].node, 'Verify Gate Posted & Build CRM Update');
  assert.equal(wf01.connections['HubSpot: Update Onboarding Record'].main[0][0].node, 'Loop Over Deals');
});

test('workflows: Load Config emits a redacted config and never the signing secret', async () => {
  const out = await runCodeNode(wf02, 'Load Config', { env: LIVE_ENV, input: [{ json: {}, binary: { data: {} } }] });
  assert.equal(out[0].json.mode, 'live');
  assert.ok(!JSON.stringify(out).includes(SIGNING_SECRET));
  assert.ok(out[0].binary, 'raw body binary is passed through for signature checks');
  await assert.rejects(runCodeNode(wf01, 'Load Config', { env: { SANDBOX_MODE: 'false' } }), /Invalid configuration/);
});

test('workflows: WF01 extract node emits one item per closed-won deal only', async () => {
  const sample = loadSample();
  const out = await runCodeNode(wf01, 'Verify & Extract Closed-Won Events', {
    env: SANDBOX_ENV,
    nodeOutputs: { 'HubSpot Deal Stage Webhook': [{ json: { headers: {}, body: sample.webhookEvents } }] }
  });
  assert.deepEqual(out.map((i) => i.json.dealId), ['9876543210']);
});

test('workflows: WF01 enforces HubSpot v3 signatures when a client secret is configured', async () => {
  const sample = loadSample();
  const body = JSON.stringify(sample.webhookEvents);
  const uri = 'https://n8n.example.com/webhook/hubspot-closed-won';
  const env = Object.assign({}, SANDBOX_ENV, { HUBSPOT_APP_CLIENT_SECRET: HUBSPOT_SECRET, HUBSPOT_WEBHOOK_TARGET_URL: uri });
  const ts = String(Date.now());
  const headers = { 'x-hubspot-request-timestamp': ts, 'x-hubspot-signature-v3': hmacBase64(HUBSPOT_SECRET, 'POST' + uri + body + ts) };
  const options = (h) => ({
    env,
    rawBody: body,
    input: [{ json: {}, binary: { data: {} } }],
    nodeOutputs: { 'HubSpot Deal Stage Webhook': [{ json: { headers: h, body: sample.webhookEvents } }] }
  });
  const ok = await runCodeNode(wf01, 'Verify & Extract Closed-Won Events', options(headers));
  assert.equal(ok.length, 1);
  await assert.rejects(runCodeNode(wf01, 'Verify & Extract Closed-Won Events', options(Object.assign({}, headers, { 'x-hubspot-signature-v3': 'forged' }))), /signature rejected/);
});

function gateInputs() {
  const sample = loadSample();
  return {
    'HubSpot: Fetch Deal': [{ json: sample.deal }],
    'HubSpot: Fetch Company': [{ json: sample.company }]
  };
}

test('workflows: WF01 gate proceeds for a fresh deal and takes the in-flight lock in live mode', async () => {
  const sample = loadSample();
  const staticData = {};
  const run = () => runCodeNode(wf01, 'Validate & Idempotency Gate', { env: LIVE_ENV, staticData, nodeOutputs: gateInputs(), input: [{ json: sample.contacts }] });
  const first = await run();
  assert.equal(first[0].json.gate.decision, 'PROCEED');
  assert.equal(Object.keys(staticData.cwoLocks).length, 1);
  const second = await run();
  assert.equal(second[0].json.gate.decision, 'SKIP_IN_FLIGHT');
  assert.equal(second[0].json.gate.shouldProvision, false);
});

test('workflows: WF01 gate skips a deal that was already provisioned (stage toggle)', async () => {
  const sample = loadSample();
  const first = await runCodeNode(wf01, 'Validate & Idempotency Gate', { env: SANDBOX_ENV, nodeOutputs: gateInputs(), input: [{ json: sample.contacts }] });
  const key = first[0].json.idempotency.key;
  const outputs = gateInputs();
  Object.assign(outputs['HubSpot: Fetch Deal'][0].json.properties, { onboarding_status: 'awaiting_approval', onboarding_idempotency_key: key });
  const second = await runCodeNode(wf01, 'Validate & Idempotency Gate', { env: SANDBOX_ENV, nodeOutputs: outputs, input: [{ json: sample.contacts }] });
  assert.equal(second[0].json.gate.decision, 'SKIP_ALREADY_PROVISIONED');
});

test('workflows: WF01 gate blocks deals that left Closed Won and invalid payloads', async () => {
  const sample = loadSample();
  const moved = gateInputs();
  moved['HubSpot: Fetch Deal'][0].json.properties.dealstage = 'contractsent';
  const out = await runCodeNode(wf01, 'Validate & Idempotency Gate', { env: SANDBOX_ENV, nodeOutputs: moved, input: [{ json: sample.contacts }] });
  assert.equal(out[0].json.gate.decision, 'SKIP_NOT_CLOSED_WON');
  const noCompany = gateInputs();
  noCompany['HubSpot: Fetch Company'] = [{ json: { error: { message: 'Not found' } } }];
  const invalid = await runCodeNode(wf01, 'Validate & Idempotency Gate', { env: SANDBOX_ENV, nodeOutputs: noCompany, input: [{ json: {} }] });
  assert.equal(invalid[0].json.gate.decision, 'BLOCK_INVALID_PAYLOAD');
});

test('workflows: WF01 plan + sandbox preview nodes produce a postable Slack payload', async () => {
  const sample = loadSample();
  const gate = await runCodeNode(wf01, 'Validate & Idempotency Gate', { env: SANDBOX_ENV, nodeOutputs: gateInputs(), input: [{ json: sample.contacts }] });
  const plan = await runCodeNode(wf01, 'Build Provisioning Plan', { env: SANDBOX_ENV, input: gate });
  assert.equal(plan[0].json.mode, 'sandbox');
  const preview = await runCodeNode(wf01, 'Build Sandbox Preview', { input: plan });
  assert.equal(preview[0].json.message.channel, 'C0APPROVAL1');
  assert.match(preview[0].json.message.text, /SANDBOX/);
});

test('workflows: WF01 Resolve Slack Channel refuses to reuse an existing channel', async () => {
  const sample = loadSample();
  const gate = await runCodeNode(wf01, 'Validate & Idempotency Gate', { env: LIVE_ENV, nodeOutputs: gateInputs(), input: [{ json: sample.contacts }] });
  const plan = await runCodeNode(wf01, 'Build Provisioning Plan', { env: LIVE_ENV, input: gate });
  const outputs = { 'Build Provisioning Plan': plan };
  await assert.rejects(runCodeNode(wf01, 'Resolve Slack Channel', { nodeOutputs: outputs, input: [{ json: { ok: false, error: 'name_taken' } }] }), /already exists/);
  const ok = await runCodeNode(wf01, 'Resolve Slack Channel', { nodeOutputs: outputs, input: [{ json: { ok: true, channel: { id: 'C0NEW00001', name: 'client-example-business-onboarding' } } }] });
  assert.equal(ok[0].json.channelId, 'C0NEW00001');
});

function signedInteraction(payload, secret) {
  const rawBody = slackInteractionBody(payload);
  const signed = signSlackRequest(rawBody, secret || SIGNING_SECRET);
  return {
    rawBody,
    input: [{ json: {}, binary: { data: {} } }],
    nodeOutputs: { 'Slack Interactivity Webhook': [{ json: { headers: { 'x-slack-request-timestamp': signed.timestamp, 'x-slack-signature': signed.signature }, body: { payload: '...' } } }] }
  };
}

test('workflows: WF02 verifies Slack signatures before parsing the payload', async () => {
  const good = await runCodeNode(wf02, 'Verify Signature & Parse Action', Object.assign({ env: LIVE_ENV }, signedInteraction(blockActionsPayload())));
  assert.equal(good[0].json.signatureValid, true);
  assert.equal(good[0].json.routing.route, 'process');
  const forged = await runCodeNode(wf02, 'Verify Signature & Parse Action', Object.assign({ env: LIVE_ENV }, signedInteraction(blockActionsPayload(), 'attacker-secret')));
  assert.equal(forged[0].json.signatureValid, false);
  assert.equal(forged[0].json.action.error, 'signature_not_verified');
});

test('workflows: WF02 rejects unauthorized approvers and builds an ephemeral notice', async () => {
  const verified = await runCodeNode(wf02, 'Verify Signature & Parse Action', Object.assign({ env: LIVE_ENV }, signedInteraction(blockActionsPayload({ userId: 'U0INTRUDER' }))));
  assert.equal(verified[0].json.routing.route, 'reject_unauthorized');
  const notice = await runCodeNode(wf02, 'Build Rejection Notice', { input: verified });
  assert.equal(notice[0].json.message.response_type, 'ephemeral');
  assert.match(notice[0].json.responseUrl, /^https:\/\/hooks\.slack\.com\//);
});

test('workflows: WF02 Plan Dispatch previews in sandbox and dispatches in live mode', async () => {
  const sample = loadSample();
  const key = 'cwo-v1-edb5a4e32d4116a6';
  const deal = JSON.parse(JSON.stringify(sample.deal));
  Object.assign(deal.properties, { onboarding_status: 'awaiting_approval', onboarding_idempotency_key: key, onboarding_slack_channel_id: 'C0CLIENT01' });
  const outputsFor = async (env, sandboxButton) => {
    const verified = await runCodeNode(wf02, 'Verify Signature & Parse Action', Object.assign({ env }, signedInteraction(blockActionsPayload({ key, sandbox: sandboxButton }))));
    return {
      'Verify Signature & Parse Action': verified,
      'HubSpot: Fetch Deal': [{ json: deal }],
      'HubSpot: Fetch Company': [{ json: sample.company }]
    };
  };
  const sandboxOut = await runCodeNode(wf02, 'Plan Dispatch', { env: SANDBOX_ENV, nodeOutputs: await outputsFor(SANDBOX_ENV, true), input: [{ json: sample.contacts }] });
  assert.equal(sandboxOut[0].json.route, 'sandbox_preview');
  assert.match(JSON.stringify(sandboxOut[0].json.outcomeMessage), /Would invite: priya\.raman/);
  const liveOut = await runCodeNode(wf02, 'Plan Dispatch', { env: LIVE_ENV, nodeOutputs: await outputsFor(LIVE_ENV, false), input: [{ json: sample.contacts }] });
  assert.equal(liveOut[0].json.route, 'dispatch');
  assert.equal(liveOut[0].json.outcomeMessage, null);
});

test('workflows: README embeds the disclaimer block and links DISCLAIMER.md', () => {
  const readme = fs.readFileSync(path.join(REPO_ROOT, 'README.md'), 'utf8');
  const disclaimer = fs.readFileSync(path.join(REPO_ROOT, 'DISCLAIMER.md'), 'utf8');
  const body = disclaimer.split('\n').slice(2).join('\n').trim();
  assert.ok(readme.includes(body), 'README contains the full disclaimer text');
  assert.ok(readme.indexOf('Disclaimer & Liability Limitation') < readme.lastIndexOf('## License'));
  assert.match(readme, /\(DISCLAIMER\.md\)/);
});
