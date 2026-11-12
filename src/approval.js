'use strict';

/**
 * src/approval.js
 * Human-in-the-loop approval handling for the client invite dispatcher:
 * parses Slack interactivity payloads, validates button state, authorizes
 * approvers and plans the dispatch against fresh HubSpot state.
 */

const { SLACK_ACTION_IDS } = require('./slack-blocks');
const { isTrustedSlackResponseUrl } = require('./security');
const { isValidIdempotencyKey, evaluateApprovalDispatch, APPROVAL_DECISION, ONBOARDING_STATUS } = require('./idempotency');
const { buildInvitePlan } = require('./provisioning-planner');

const APPROVAL_ROUTES = Object.freeze({
  REJECT_SIGNATURE: 'reject_signature',
  REJECT_INVALID: 'reject_invalid',
  REJECT_UNAUTHORIZED: 'reject_unauthorized',
  REJECT_SANDBOX_ARTIFACT: 'reject_sandbox_artifact',
  PROCESS: 'process'
});

const DISPATCH_ROUTES = Object.freeze({
  DISPATCH: 'dispatch',
  HOLD: 'hold',
  SANDBOX_PREVIEW: 'sandbox_preview',
  SKIPPED: 'skipped',
  BLOCKED: 'blocked'
});

function decodeFormComponent(value) {
  try {
    return decodeURIComponent(String(value).replace(/\+/g, ' '));
  } catch (error) {
    return null;
  }
}

function parseFormUrlEncoded(raw) {
  const out = {};
  for (const pair of String(raw || '').split('&')) {
    if (!pair) continue;
    const index = pair.indexOf('=');
    const key = decodeFormComponent(index === -1 ? pair : pair.slice(0, index));
    const value = decodeFormComponent(index === -1 ? '' : pair.slice(index + 1));
    if (key === null || value === null) return null;
    out[key] = value;
  }
  return out;
}

/**
 * Slack sends interactivity as application/x-www-form-urlencoded "payload=<json>".
 */
function parseSlackInteractionBody(rawBody) {
  const form = parseFormUrlEncoded(rawBody);
  if (!form || !form.payload) return { ok: false, error: 'missing_payload', payload: null };
  try {
    const payload = JSON.parse(form.payload);
    if (!payload || typeof payload !== 'object') return { ok: false, error: 'invalid_payload', payload: null };
    return { ok: true, error: null, payload };
  } catch (error) {
    return { ok: false, error: 'invalid_payload_json', payload: null };
  }
}

function parseApprovalButtonValue(value) {
  let parsed;
  try {
    parsed = JSON.parse(String(value || ''));
  } catch (error) {
    return { ok: false, error: 'invalid_button_value' };
  }
  if (!parsed || parsed.v !== 1) return { ok: false, error: 'unsupported_button_version' };
  if (!/^[A-Za-z0-9_-]{1,64}$/.test(String(parsed.dealId || ''))) return { ok: false, error: 'invalid_deal_id' };
  if (!isValidIdempotencyKey(parsed.key)) return { ok: false, error: 'invalid_idempotency_key' };
  const channel = String(parsed.clientChannelId || '');
  if (channel && !/^[CG][A-Z0-9]{6,}$/.test(channel)) return { ok: false, error: 'invalid_client_channel' };
  if (typeof parsed.sandbox !== 'boolean') return { ok: false, error: 'invalid_sandbox_flag' };
  return { ok: true, value: { dealId: String(parsed.dealId), idempotencyKey: parsed.key, clientChannelId: channel, sandbox: parsed.sandbox } };
}

/**
 * Extract the approval action from a Slack block_actions payload.
 */
function extractApprovalAction(payload) {
  const p = payload || {};
  if (p.type !== 'block_actions') return { ok: false, error: 'unsupported_interaction_type' };
  const action = Array.isArray(p.actions) ? p.actions[0] : null;
  if (!action) return { ok: false, error: 'missing_action' };
  let kind = null;
  if (action.action_id === SLACK_ACTION_IDS.APPROVE) kind = 'approve';
  if (action.action_id === SLACK_ACTION_IDS.HOLD) kind = 'hold';
  if (!kind) return { ok: false, error: 'unknown_action_id' };
  const value = parseApprovalButtonValue(action.value);
  if (!value.ok) return { ok: false, error: value.error };
  const responseUrl = String(p.response_url || '');
  if (!isTrustedSlackResponseUrl(responseUrl)) return { ok: false, error: 'untrusted_response_url' };
  const user = p.user || {};
  if (!/^[UW][A-Z0-9]{2,}$/.test(String(user.id || ''))) return { ok: false, error: 'invalid_user' };
  return {
    ok: true,
    error: null,
    action: kind,
    dealId: value.value.dealId,
    idempotencyKey: value.value.idempotencyKey,
    clientChannelId: value.value.clientChannelId,
    sandbox: value.value.sandbox,
    userId: String(user.id),
    userName: String(user.username || user.name || ''),
    teamId: String((p.team && p.team.id) || ''),
    responseUrl,
    approvalChannelId: String((p.channel && p.channel.id) || ''),
    messageTs: String((p.container && p.container.message_ts) || (p.message && p.message.ts) || '')
  };
}

function authorizeApprover(userId, approverIds, options) {
  const ids = approverIds || [];
  const sandboxMode = Boolean(options && options.sandboxMode);
  if (ids.length === 0) {
    return sandboxMode
      ? { authorized: true, reason: 'sandbox_open_approval' }
      : { authorized: false, reason: 'no_approvers_configured' };
  }
  return ids.includes(userId)
    ? { authorized: true, reason: 'listed_approver' }
    : { authorized: false, reason: 'not_an_approver' };
}

/**
 * First-stage routing right after the webhook (before any HubSpot read).
 */
function routeApprovalRequest(params) {
  const p = params || {};
  if (!p.signature || !p.signature.valid) {
    return { route: APPROVAL_ROUTES.REJECT_SIGNATURE, reason: (p.signature && p.signature.reason) || 'signature_not_verified' };
  }
  if (!p.action || !p.action.ok) {
    return { route: APPROVAL_ROUTES.REJECT_INVALID, reason: (p.action && p.action.error) || 'invalid_action' };
  }
  if (!p.sandboxMode && p.action.sandbox) {
    return { route: APPROVAL_ROUTES.REJECT_SANDBOX_ARTIFACT, reason: 'Sandbox approval buttons cannot trigger live dispatch.' };
  }
  const auth = authorizeApprover(p.action.userId, p.approverIds, { sandboxMode: p.sandboxMode });
  if (!auth.authorized) return { route: APPROVAL_ROUTES.REJECT_UNAUTHORIZED, reason: auth.reason };
  return { route: APPROVAL_ROUTES.PROCESS, reason: auth.reason };
}

/**
 * Second-stage planning with fresh HubSpot state.
 * @param {object} p
 * @param {object} p.action output of extractApprovalAction
 * @param {object} p.normalized output value of normalizeDealPayload
 * @param {object} p.config loaded config
 */
function planApprovalDispatch(p) {
  const params = p || {};
  const action = params.action;
  const normalized = params.normalized;
  const config = params.config;
  if (!action || !normalized || !config) throw new Error('planApprovalDispatch requires action, normalized and config.');
  const deal = normalized.deal;
  const sandbox = config.sandboxMode;
  const simulated = sandbox && action.sandbox;

  const crmState = simulated
    ? { storedKey: action.idempotencyKey, onboardingStatus: ONBOARDING_STATUS.AWAITING_APPROVAL, storedChannelId: action.clientChannelId }
    : { storedKey: deal.storedIdempotencyKey, onboardingStatus: deal.onboardingStatus, storedChannelId: deal.storedSlackChannelId };

  const invitePlan = buildInvitePlan({
    contacts: normalized.contacts,
    companyDomain: normalized.company.domain,
    policy: config.invites.policy,
    allowedDomains: config.invites.allowedDomains,
    maxInvites: config.invites.maxPerDeal
  });

  const base = {
    action: action.action,
    simulatedCrmState: simulated,
    invitePlan,
    clientChannelId: crmState.storedChannelId || action.clientChannelId,
    dealId: deal.id
  };

  if (deal.id !== action.dealId) {
    return Object.assign(base, { route: DISPATCH_ROUTES.BLOCKED, decision: 'BLOCK_DEAL_MISMATCH', reason: 'Button deal ID does not match the fetched deal.' });
  }

  const decision = evaluateApprovalDispatch({
    requestedKey: action.idempotencyKey,
    storedKey: crmState.storedKey,
    onboardingStatus: crmState.onboardingStatus,
    action: action.action
  });

  if (!decision.allowed) {
    const skipped = decision.decision === APPROVAL_DECISION.SKIP_ALREADY_DISPATCHED || decision.decision === APPROVAL_DECISION.SKIP_ALREADY_HELD;
    return Object.assign(base, { route: skipped ? DISPATCH_ROUTES.SKIPPED : DISPATCH_ROUTES.BLOCKED, decision: decision.decision, reason: decision.reason });
  }

  if (!simulated && action.action === 'approve' && action.clientChannelId !== crmState.storedChannelId) {
    return Object.assign(base, { route: DISPATCH_ROUTES.BLOCKED, decision: 'BLOCK_CHANNEL_MISMATCH', reason: 'Client channel in the button does not match the channel stored on the deal.' });
  }

  if (action.action === 'approve' && invitePlan.invite.length === 0) {
    return Object.assign(base, { route: DISPATCH_ROUTES.BLOCKED, decision: 'BLOCK_NO_ELIGIBLE_CONTACTS', reason: 'No client contacts pass the external invite policy.' });
  }

  if (sandbox) {
    return Object.assign(base, { route: DISPATCH_ROUTES.SANDBOX_PREVIEW, decision: decision.decision, reason: 'SANDBOX_MODE=true: dispatch simulated only.' });
  }

  return Object.assign(base, {
    route: action.action === 'approve' ? DISPATCH_ROUTES.DISPATCH : DISPATCH_ROUTES.HOLD,
    decision: decision.decision,
    reason: decision.reason
  });
}

module.exports = {
  APPROVAL_ROUTES,
  DISPATCH_ROUTES,
  parseFormUrlEncoded,
  parseSlackInteractionBody,
  parseApprovalButtonValue,
  extractApprovalAction,
  authorizeApprover,
  routeApprovalRequest,
  planApprovalDispatch
};
