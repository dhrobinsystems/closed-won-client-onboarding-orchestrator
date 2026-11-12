'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const security = require('../src/security');
const approval = require('../src/approval');
const { loadConfig } = require('../src/config');
const { normalizeDealPayload } = require('../src/sanitizer');
const { buildIdempotencyKey } = require('../src/idempotency');
const {
  SIGNING_SECRET,
  HUBSPOT_SECRET,
  LIVE_ENV,
  SANDBOX_ENV,
  hmacHex,
  hmacBase64,
  signSlackRequest,
  slackInteractionBody,
  blockActionsPayload,
  loadSample
} = require('./helpers/n8n-harness');

const NOW_S = 1_800_000_000;

function verify(rawBody, overrides) {
  const signed = signSlackRequest(rawBody, SIGNING_SECRET, NOW_S);
  return security.verifySlackSignature(Object.assign({
    signingSecret: SIGNING_SECRET,
    timestamp: signed.timestamp,
    signature: signed.signature,
    rawBody,
    nowSeconds: NOW_S,
    hmacSha256Hex: hmacHex
  }, overrides || {}));
}

test('security: valid Slack signatures verify', () => {
  assert.deepEqual(verify('payload=%7B%7D'), { valid: true, reason: 'ok' });
});

test('security: tampered bodies, wrong secrets, stale or malformed headers are rejected', () => {
  const signed = signSlackRequest('payload=a', SIGNING_SECRET, NOW_S);
  assert.equal(verify('payload=b', { signature: signed.signature }).reason, 'signature_mismatch');
  assert.equal(verify('payload=a', { signingSecret: 'other-secret' }).reason, 'signature_mismatch');
  assert.equal(verify('payload=a', { nowSeconds: NOW_S + 301 }).reason, 'stale_timestamp');
  assert.equal(verify('payload=a', { signature: 'v1=abc' }).reason, 'malformed_signature');
  assert.equal(verify('payload=a', { signingSecret: '' }).reason, 'missing_signing_secret');
  assert.equal(verify('payload=a', { rawBody: null }).reason, 'missing_raw_body');
  assert.equal(verify('payload=a', { timestamp: 'abc' }).reason, 'invalid_timestamp');
});

test('security: HubSpot v3 signatures verify and reject tampering/staleness', () => {
  const nowMs = NOW_S * 1000;
  const uri = 'https://n8n.example.com/webhook/hubspot-closed-won';
  const body = '[{"objectId":1}]';
  const signature = hmacBase64(HUBSPOT_SECRET, 'POST' + uri + body + String(nowMs));
  const base = { clientSecret: HUBSPOT_SECRET, method: 'post', uri, rawBody: body, timestamp: String(nowMs), signature, nowMs, hmacSha256Base64: hmacBase64 };
  assert.equal(security.verifyHubSpotSignatureV3(base).valid, true);
  assert.equal(security.verifyHubSpotSignatureV3(Object.assign({}, base, { rawBody: '[]' })).reason, 'signature_mismatch');
  assert.equal(security.verifyHubSpotSignatureV3(Object.assign({}, base, { nowMs: nowMs + 301000 })).reason, 'stale_timestamp');
  assert.equal(security.verifyHubSpotSignatureV3(Object.assign({}, base, { clientSecret: '' })).reason, 'missing_client_secret');
});

test('security: constant-time compare, header lookup and response_url allowlist', () => {
  assert.equal(security.constantTimeEqual('abc', 'abc'), true);
  assert.equal(security.constantTimeEqual('abc', 'abd'), false);
  assert.equal(security.constantTimeEqual('abc', 'abcd'), false);
  assert.equal(security.getHeader({ 'X-Slack-Signature': ['v0=1'] }, 'x-slack-signature'), 'v0=1');
  assert.equal(security.isTrustedSlackResponseUrl('https://hooks.slack.com/actions/T1/2/abc'), true);
  assert.equal(security.isTrustedSlackResponseUrl('https://hooks.slack.com.evil.example.com/actions/x'), false);
  assert.equal(security.isTrustedSlackResponseUrl('http://hooks.slack.com/actions/x'), false);
  assert.equal(security.isTrustedSlackResponseUrl('https://169.254.169.254/latest'), false);
});

test('approval: form-encoded Slack payload parses into a validated approval action', () => {
  const parsed = approval.parseSlackInteractionBody(slackInteractionBody(blockActionsPayload()));
  assert.equal(parsed.ok, true);
  const action = approval.extractApprovalAction(parsed.payload);
  assert.equal(action.ok, true);
  assert.equal(action.action, 'approve');
  assert.equal(action.dealId, '9876543210');
  assert.equal(action.userId, 'U0APPROVER1');
  assert.equal(action.sandbox, false);
  assert.equal(approval.extractApprovalAction(blockActionsPayload({ actionId: 'cwo_hold_onboarding' })).action, 'hold');
});

test('approval: malformed bodies and payloads are rejected with precise reasons', () => {
  assert.equal(approval.parseSlackInteractionBody('nothing=here').error, 'missing_payload');
  assert.equal(approval.parseSlackInteractionBody('payload=%7Bbad').error, 'invalid_payload_json');
  assert.equal(approval.parseSlackInteractionBody('payload=%E0%A4%A').error, 'missing_payload');
  assert.equal(approval.extractApprovalAction({ type: 'view_submission' }).error, 'unsupported_interaction_type');
  assert.equal(approval.extractApprovalAction(blockActionsPayload({ actionId: 'delete_everything' })).error, 'unknown_action_id');
  assert.equal(approval.extractApprovalAction(blockActionsPayload({ key: 'forged' })).error, 'invalid_idempotency_key');
  assert.equal(approval.extractApprovalAction(blockActionsPayload({ value: '{not json' })).error, 'invalid_button_value');
  assert.equal(approval.extractApprovalAction(blockActionsPayload({ responseUrl: 'https://attacker.example.com/cb' })).error, 'untrusted_response_url');
  assert.equal(approval.extractApprovalAction(blockActionsPayload({ userId: 'bot' })).error, 'invalid_user');
});

test('approval: approver authorization is allowlist-based and closed by default in live mode', () => {
  assert.equal(approval.authorizeApprover('U1', ['U1'], { sandboxMode: false }).authorized, true);
  assert.equal(approval.authorizeApprover('U2', ['U1'], { sandboxMode: false }).authorized, false);
  assert.equal(approval.authorizeApprover('U2', [], { sandboxMode: false }).authorized, false);
  assert.equal(approval.authorizeApprover('U2', [], { sandboxMode: true }).authorized, true);
});

test('approval: routing rejects bad signatures, unauthorized users and sandbox buttons in live mode', () => {
  const action = approval.extractApprovalAction(blockActionsPayload());
  const ok = { valid: true };
  assert.equal(approval.routeApprovalRequest({ signature: { valid: false, reason: 'x' }, action }).route, 'reject_signature');
  assert.equal(approval.routeApprovalRequest({ signature: ok, action: { ok: false, error: 'e' } }).route, 'reject_invalid');
  assert.equal(approval.routeApprovalRequest({ signature: ok, action, sandboxMode: false, approverIds: ['U0SOMEONE'] }).route, 'reject_unauthorized');
  assert.equal(approval.routeApprovalRequest({ signature: ok, action, sandboxMode: false, approverIds: ['U0APPROVER1'] }).route, 'process');
  const sandboxAction = approval.extractApprovalAction(blockActionsPayload({ sandbox: true }));
  assert.equal(approval.routeApprovalRequest({ signature: ok, action: sandboxAction, sandboxMode: false, approverIds: ['U0APPROVER1'] }).route, 'reject_sandbox_artifact');
});

function dispatchFixture(envBase, crm, actionOverrides) {
  const sample = loadSample();
  const { config } = loadConfig(envBase, { context: 'approval' });
  const company = sample.company;
  const key = buildIdempotencyKey({ dealId: '9876543210', stageId: 'closedwon', accountDomain: 'example-business.example.com' }).key;
  Object.assign(sample.deal.properties, {
    onboarding_status: crm.status,
    onboarding_idempotency_key: crm.key === undefined ? key : crm.key,
    onboarding_slack_channel_id: crm.channel === undefined ? 'C0CLIENT01' : crm.channel
  });
  const normalized = normalizeDealPayload({ deal: sample.deal, company, contacts: sample.contacts }).value;
  const action = approval.extractApprovalAction(blockActionsPayload(Object.assign({ key }, actionOverrides || {})));
  return approval.planApprovalDispatch({ action, normalized, config });
}

test('approval: live approve with matching CRM state routes to dispatch with policy-filtered invites', () => {
  const plan = dispatchFixture(LIVE_ENV, { status: 'awaiting_approval' });
  assert.equal(plan.route, 'dispatch');
  assert.equal(plan.clientChannelId, 'C0CLIENT01');
  assert.deepEqual(plan.invitePlan.invite.map((i) => i.email), ['priya.raman@example-business.example.com', 'marcus.lee@example-business.example.com']);
});

test('approval: double-click after dispatch is skipped; stale/foreign buttons are blocked', () => {
  assert.equal(dispatchFixture(LIVE_ENV, { status: 'client_invited' }).route, 'skipped');
  assert.equal(dispatchFixture(LIVE_ENV, { status: 'awaiting_approval', key: 'cwo-v1-aaaaaaaaaaaaaaaa' }).decision, 'BLOCK_KEY_MISMATCH');
  assert.equal(dispatchFixture(LIVE_ENV, { status: 'awaiting_approval', channel: 'C0OTHER001' }).decision, 'BLOCK_CHANNEL_MISMATCH');
  assert.equal(dispatchFixture(LIVE_ENV, { status: 'awaiting_approval' }, { dealId: '111' }).decision, 'BLOCK_DEAL_MISMATCH');
});

test('approval: live hold routes to hold; repeated hold is skipped', () => {
  assert.equal(dispatchFixture(LIVE_ENV, { status: 'awaiting_approval' }, { actionId: 'cwo_hold_onboarding' }).route, 'hold');
  assert.equal(dispatchFixture(LIVE_ENV, { status: 'on_hold' }, { actionId: 'cwo_hold_onboarding' }).route, 'skipped');
});

test('approval: approve is blocked when no contact passes the invite policy', () => {
  const env = Object.assign({}, LIVE_ENV, { EXTERNAL_INVITE_DOMAIN_POLICY: 'allowlist', EXTERNAL_INVITE_ALLOWED_DOMAINS: 'nobody.example.org' });
  assert.equal(dispatchFixture(env, { status: 'awaiting_approval' }).decision, 'BLOCK_NO_ELIGIBLE_CONTACTS');
});

test('approval: sandbox buttons in sandbox mode simulate CRM state and only preview', () => {
  const plan = dispatchFixture(SANDBOX_ENV, { status: '', key: '', channel: '' }, { sandbox: true, clientChannelId: '' });
  assert.equal(plan.route, 'sandbox_preview');
  assert.equal(plan.simulatedCrmState, true);
});
