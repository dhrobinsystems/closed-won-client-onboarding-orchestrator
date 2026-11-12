'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { loadConfig } = require('../src/config');
const { normalizeDealPayload } = require('../src/sanitizer');
const { buildIdempotencyKey } = require('../src/idempotency');
const { buildProvisioningPlan, buildFallbackAgenda } = require('../src/provisioning-planner');
const blocks = require('../src/slack-blocks');
const { loadSample, LIVE_ENV } = require('./helpers/n8n-harness');

function manifestFor(envOverrides, companyName) {
  const sample = loadSample();
  if (companyName) sample.company.properties.name = companyName;
  const { config } = loadConfig(Object.assign({}, LIVE_ENV, envOverrides || {}));
  const normalized = normalizeDealPayload({ deal: sample.deal, company: sample.company, contacts: sample.contacts }).value;
  const key = buildIdempotencyKey({ dealId: normalized.deal.id, stageId: normalized.deal.stageId, accountDomain: normalized.company.domain }).key;
  return buildProvisioningPlan({ normalized, config, idempotencyKey: key, now: '2026-11-13T09:00:00.000Z' });
}

function gateMessage(manifest, agendaText) {
  return blocks.buildApprovalGateMessage({
    manifest,
    provisioned: { channelId: 'C0CLIENT01', driveFolderUrl: 'https://drive.google.com/drive/folders/abc', workspaceUrl: '', tasksCreated: 6 },
    agenda: { source: 'fallback', agenda: agendaText || buildFallbackAgenda(manifest.kickoff.prompt.groundingFacts), issues: [] }
  });
}

const allText = (message) => JSON.stringify(message.blocks);

test('slack-blocks: approval gate posts to the internal channel with Approve and Hold buttons', () => {
  const manifest = manifestFor();
  const message = gateMessage(manifest);
  assert.equal(message.channel, 'C0APPROVAL1');
  const actions = message.blocks.find((b) => b.type === 'actions');
  assert.deepEqual(actions.elements.map((e) => e.action_id), [blocks.SLACK_ACTION_IDS.APPROVE, blocks.SLACK_ACTION_IDS.HOLD]);
  assert.equal(actions.elements[0].style, 'primary');
  assert.ok(actions.elements[0].confirm, 'approve requires a confirmation dialog');
  const value = JSON.parse(actions.elements[0].value);
  assert.deepEqual(value, { v: 1, dealId: '9876543210', key: manifest.idempotencyKey, clientChannelId: 'C0CLIENT01', sandbox: false });
});

test('slack-blocks: approval gate states that nothing external has been sent yet', () => {
  const text = allText(gateMessage(manifestFor()));
  assert.match(text, /Human approval required/);
  assert.match(text, /No external email has been invited/);
  assert.match(text, /priya\.raman@example-business\.example\.com/);
  assert.match(text, /freelance\.consultant@example\.net~ .* blocked: domain_does_not_match_company/);
});

test('slack-blocks: user-controlled text is escaped (no @channel or link injection)', () => {
  const manifest = manifestFor({}, '<!channel> Evil <https://phish.example.com|Click>');
  const text = allText(gateMessage(manifest));
  assert.ok(!text.includes('<!channel>'));
  assert.ok(!text.includes('<https://phish.example.com|Click>'));
  assert.match(text, /&lt;!channel&gt;/);
});

test('slack-blocks: messages respect Slack limits (50 blocks, 3000 chars per section)', () => {
  const message = gateMessage(manifestFor(), '## Agenda\n' + 'x'.repeat(10000));
  assert.ok(message.blocks.length <= 50);
  for (const block of message.blocks) {
    if (block.text) assert.ok(block.text.text.length <= 3000);
  }
});

test('slack-blocks: sandbox preview is clearly labelled and its buttons are flagged sandbox', () => {
  const manifest = manifestFor({ SANDBOX_MODE: 'true' });
  const message = blocks.buildSandboxPreviewMessage({ manifest, idempotency: { decision: 'PROCEED', reason: 'fresh' }, warnings: ['w1'] });
  assert.match(message.text, /^\[SANDBOX\]/);
  assert.match(message.blocks[0].text.text, /SANDBOX DRY RUN/);
  const text = allText(message);
  assert.match(text, /SANDBOX_MODE=true/);
  assert.match(text, /01_Contracts_and_SOW/);
  assert.match(text, /client-example-business-onboarding/);
  const actions = message.blocks.find((b) => b.type === 'actions');
  assert.equal(JSON.parse(actions.elements[0].value).sandbox, true);
  assert.match(actions.elements[0].text.text, /^\(Sandbox\)/);
});

test('slack-blocks: markdown agenda converts headings and bullets to Slack mrkdwn', () => {
  assert.equal(blocks.markdownToMrkdwn('## Objectives\n- **Bold** item\n<x>'), '*Objectives*\n\u2022 *Bold* item\n&lt;x&gt;');
});

test('slack-blocks: welcome packet targets the client channel and never leaks internal links', () => {
  const message = blocks.buildWelcomeMessage({ channelId: 'C0CLIENT01', companyName: 'Example Business', orgName: 'dhRobin Systems', invitees: [{ name: 'Priya Raman' }] });
  assert.equal(message.channel, 'C0CLIENT01');
  const text = allText(message);
  assert.ok(!/drive\.google\.com|hubspot\.com/.test(text));
  assert.match(text, /never share passwords/);
  assert.throws(() => blocks.buildWelcomeMessage({}), /channelId/);
});

test('slack-blocks: outcome and rejection messages for response_url', () => {
  const approved = blocks.buildApprovalOutcomeMessage({ outcome: 'approved', actorId: 'U0APPROVER1', dealName: 'D', details: ['Invited: a@example.com'], replaceOriginal: true });
  assert.equal(approved.replace_original, true);
  assert.match(approved.text, /approved and dispatched/);
  const unknown = blocks.buildApprovalOutcomeMessage({ outcome: 'nonsense' });
  assert.match(unknown.text, /blocked/);
  const rejection = blocks.buildEphemeralRejection('Not allowed');
  assert.equal(rejection.response_type, 'ephemeral');
  assert.equal(rejection.replace_original, false);
});

test('slack-blocks: money formatting and button value size guard', () => {
  assert.equal(blocks.formatMoney(48500, 'USD'), '$48,500');
  assert.equal(blocks.formatMoney(null), 'Not set');
  assert.throws(() => blocks.buildApprovalButtonValue({ dealId: 'x'.repeat(2100) }), /limit/);
});
