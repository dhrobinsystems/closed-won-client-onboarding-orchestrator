'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { loadConfig } = require('../src/config');
const approval = require('../src/approval');
const { normalizeDealPayload } = require('../src/sanitizer');
const { buildIdempotencyKey } = require('../src/idempotency');
const { checkWorkflow, reachableWithoutLiveGates } = require('../scripts/check-workflows');
const {
  WF01_FILE,
  WF02_FILE,
  SANDBOX_ENV,
  LIVE_ENV,
  loadWorkflow,
  loadSample,
  getNode,
  runCodeNode,
  blockActionsPayload
} = require('./helpers/n8n-harness');

const wf01 = loadWorkflow(WF01_FILE);
const wf02 = loadWorkflow(WF02_FILE);

test('sandbox: any missing, empty or unrecognised SANDBOX_MODE value keeps sandbox ON', () => {
  for (const value of [undefined, '', '  ', 'flase', 'disabled', 'null', '2']) {
    assert.equal(loadConfig({ SANDBOX_MODE: value }).config.sandboxMode, true, String(value));
  }
});

test('sandbox: planApprovalDispatch never returns a live route while SANDBOX_MODE=true', () => {
  const sample = loadSample();
  const { config } = loadConfig(SANDBOX_ENV, { context: 'approval' });
  const key = buildIdempotencyKey({ dealId: '9876543210', stageId: 'closedwon', accountDomain: 'example-business.example.com' }).key;
  for (const status of ['', 'provisioning', 'awaiting_approval', 'on_hold', 'client_invited', 'failed']) {
    for (const actionId of ['cwo_approve_external_invites', 'cwo_hold_onboarding']) {
      for (const sandboxButton of [true, false]) {
        const deal = JSON.parse(JSON.stringify(sample.deal));
        Object.assign(deal.properties, { onboarding_status: status, onboarding_idempotency_key: key, onboarding_slack_channel_id: 'C0CLIENT01' });
        const normalized = normalizeDealPayload({ deal, company: sample.company, contacts: sample.contacts }).value;
        const action = approval.extractApprovalAction(blockActionsPayload({ key, actionId, sandbox: sandboxButton }));
        const plan = approval.planApprovalDispatch({ action, normalized, config });
        assert.ok(!['dispatch', 'hold'].includes(plan.route), status + '/' + actionId + '/' + sandboxButton + ' -> ' + plan.route);
      }
    }
  }
});

test('sandbox: WF01 gate routes only the exact value "live" to the live branch (fail-safe default)', () => {
  const gate = getNode(wf01, 'Live Mode? (SANDBOX_MODE=false)');
  const condition = gate.parameters.conditions.conditions[0];
  assert.equal(condition.leftValue, '={{ $json.mode }}');
  assert.equal(condition.rightValue, 'live');
  assert.equal(condition.operator.operation, 'equals');
  const outputs = wf01.connections['Live Mode? (SANDBOX_MODE=false)'].main;
  assert.equal(outputs[0][0].node, 'Assert Live Mode');
  assert.equal(outputs[1][0].node, 'Build Sandbox Preview');
});

test('sandbox: "Assert Live Mode" re-reads the environment and halts if sandbox is on', async () => {
  await assert.rejects(runCodeNode(wf01, 'Assert Live Mode', { env: SANDBOX_ENV, input: [{ json: { mode: 'live' } }] }), /Safety stop/);
  const passthrough = await runCodeNode(wf01, 'Assert Live Mode', { env: LIVE_ENV, input: [{ json: { mode: 'live' } }] });
  assert.equal(passthrough[0].json.mode, 'live');
});

test('sandbox: WF02 live invite and hold branches halt if sandbox is on', async () => {
  const item = { json: { route: 'dispatch', plan: { clientChannelId: 'C0CLIENT01', invitePlan: { invite: [{ email: 'a@example.com', name: 'A' }] } } } };
  await assert.rejects(runCodeNode(wf02, 'Prepare Invite Requests', { env: SANDBOX_ENV, input: [item] }), /Safety stop/);
  await assert.rejects(runCodeNode(wf02, 'Prepare Hold Record', { env: SANDBOX_ENV, input: [item] }), /Safety stop/);
  const live = await runCodeNode(wf02, 'Prepare Invite Requests', { env: LIVE_ENV, input: [item] });
  assert.deepEqual(live.map((i) => i.json.email), ['a@example.com']);
});

test('sandbox: blocked $env access in n8n falls back to sandbox mode', async () => {
  const out = await runCodeNode(wf01, 'Load Config', { envBlocked: true });
  assert.equal(out[0].json.mode, 'sandbox');
  assert.ok(out[0].json.warnings.some((w) => /blocked \$env access/.test(w)));
});

test('sandbox: no mutating HTTP node is reachable without crossing a live-only gate', () => {
  for (const wf of [wf01, wf02]) {
    const { reachable } = reachableWithoutLiveGates(wf);
    const exposed = wf.nodes.filter((n) => reachable.has(n.name) && n.type === 'n8n-nodes-base.httpRequest' && String(n.parameters.method).toUpperCase() !== 'GET');
    for (const node of exposed) assert.match(String(node.notes), /\[sandbox-safe\]/, node.name);
    assert.ok(!reachable.has('Slack: Create Client Channel') && !reachable.has('Slack: Invite External Contact'));
  }
});

test('sandbox: the checker flags a workflow whose sandbox gate was removed', () => {
  const tampered = JSON.parse(JSON.stringify(wf01));
  getNode(tampered, 'Live Mode? (SANDBOX_MODE=false)').notes = 'gate annotation removed';
  const errors = checkWorkflow('tampered.json', tampered, [], new Set());
  assert.ok(errors.some((e) => /no \[sandbox-gate\] node declared/.test(e)));
  assert.ok(errors.some((e) => /Slack: Create Client Channel.*reachable in SANDBOX_MODE/.test(e)));
});
