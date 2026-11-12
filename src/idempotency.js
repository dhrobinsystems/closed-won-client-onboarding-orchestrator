'use strict';

/**
 * src/idempotency.js
 * Deterministic idempotency keys and state evaluation.
 *
 * Key = hash(version | dealId | stageId | normalizedAccountDomain).
 *
 * Two layers protect against duplicate provisioning:
 *  1. Durable CRM state: the key + onboarding_status are written to the deal
 *     in HubSpot at the start of a live run. If a rep toggles the deal out of
 *     and back into Closed Won, the same key is recomputed and the run skips.
 *  2. Short-lived in-flight lock (n8n workflow static data): closes the race
 *     window when HubSpot delivers the same event twice within seconds,
 *     before the CRM write has landed.
 */

const { normalizeDomain } = require('./sanitizer');

const IDEMPOTENCY_KEY_VERSION = 'v1';
const IDEMPOTENCY_KEY_PATTERN = /^cwo-v1-[a-f0-9]{16}$/;

const ONBOARDING_STATUS = Object.freeze({
  NONE: '',
  PROVISIONING: 'provisioning',
  AWAITING_APPROVAL: 'awaiting_approval',
  ON_HOLD: 'on_hold',
  CLIENT_INVITED: 'client_invited',
  FAILED: 'failed'
});

const IDEMPOTENCY_DECISION = Object.freeze({
  PROCEED: 'PROCEED',
  SKIP_ALREADY_PROVISIONED: 'SKIP_ALREADY_PROVISIONED',
  SKIP_IN_FLIGHT: 'SKIP_IN_FLIGHT',
  BLOCK_KEY_CONFLICT: 'BLOCK_KEY_CONFLICT',
  BLOCK_REQUIRES_REVIEW: 'BLOCK_REQUIRES_REVIEW'
});

const APPROVAL_DECISION = Object.freeze({
  PROCEED: 'PROCEED',
  SKIP_ALREADY_DISPATCHED: 'SKIP_ALREADY_DISPATCHED',
  SKIP_ALREADY_HELD: 'SKIP_ALREADY_HELD',
  BLOCK_KEY_MISMATCH: 'BLOCK_KEY_MISMATCH',
  BLOCK_ALREADY_DISPATCHED: 'BLOCK_ALREADY_DISPATCHED',
  BLOCK_INVALID_STATE: 'BLOCK_INVALID_STATE',
  BLOCK_UNKNOWN_ACTION: 'BLOCK_UNKNOWN_ACTION'
});

const COMPLETED_STATUSES = Object.freeze([
  ONBOARDING_STATUS.AWAITING_APPROVAL,
  ONBOARDING_STATUS.ON_HOLD,
  ONBOARDING_STATUS.CLIENT_INVITED
]);

function fnv1a32(input, seed) {
  let hash = seed >>> 0;
  for (let i = 0; i < input.length; i += 1) {
    hash ^= input.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash >>> 0;
}

/**
 * Deterministic 64-bit (16 hex chars) non-cryptographic hash built from two
 * independently seeded FNV-1a passes. Stable across Node versions and n8n.
 */
function deterministicHash64(input) {
  const text = String(input);
  const a = fnv1a32(text, 0x811c9dc5).toString(16).padStart(8, '0');
  const b = fnv1a32(text.split('').reverse().join(''), 0x9747b28c).toString(16).padStart(8, '0');
  return a + b;
}

/**
 * @returns {{key:string, canonical:string, parts:{dealId:string, stageId:string, domain:string}}}
 */
function buildIdempotencyKey(input) {
  const source = input || {};
  const parts = {
    dealId: String(source.dealId === undefined || source.dealId === null ? '' : source.dealId).trim(),
    stageId: String(source.stageId === undefined || source.stageId === null ? '' : source.stageId).trim(),
    domain: normalizeDomain(source.accountDomain)
  };
  const missing = Object.keys(parts).filter((name) => !parts[name]);
  if (missing.length > 0) {
    throw new Error('Cannot build idempotency key: missing or invalid ' + missing.join(', ') + '.');
  }
  const canonical = [IDEMPOTENCY_KEY_VERSION, parts.dealId, parts.stageId, parts.domain].join('|');
  return {
    key: 'cwo-' + IDEMPOTENCY_KEY_VERSION + '-' + deterministicHash64(canonical),
    canonical,
    parts
  };
}

function isValidIdempotencyKey(key) {
  return IDEMPOTENCY_KEY_PATTERN.test(String(key || ''));
}

function normalizeStatus(status) {
  return String(status === undefined || status === null ? '' : status).trim().toLowerCase();
}

function isLockActive(entry, nowMs, ttlMs) {
  return Boolean(entry && Number.isFinite(entry.lockedAt) && nowMs - entry.lockedAt < ttlMs);
}

function decide(decision, reason, key) {
  return { decision, shouldProvision: decision === IDEMPOTENCY_DECISION.PROCEED, reason, key };
}

/**
 * Decide whether provisioning may run for a deal.
 * @param {object} p
 * @param {string} p.key freshly computed idempotency key
 * @param {string} [p.storedKey] key stored on the HubSpot deal
 * @param {string} [p.onboardingStatus] onboarding_status stored on the deal
 * @param {{lockedAt:number}} [p.lockEntry] in-flight lock entry for this key
 * @param {number} p.nowMs
 * @param {number} [p.lockTtlMs=900000]
 */
function evaluateIdempotency(p) {
  const params = p || {};
  if (!isValidIdempotencyKey(params.key)) throw new Error('evaluateIdempotency requires a valid key.');
  const ttl = Number.isFinite(params.lockTtlMs) ? params.lockTtlMs : 15 * 60 * 1000;
  const now = Number.isFinite(params.nowMs) ? params.nowMs : Date.now();
  const status = normalizeStatus(params.onboardingStatus);
  const storedKey = String(params.storedKey || '').trim();
  const key = params.key;

  if (storedKey && storedKey !== key && status) {
    return decide(IDEMPOTENCY_DECISION.BLOCK_KEY_CONFLICT,
      'Deal already carries a different onboarding key (' + storedKey + ') with status "' + status + '". The deal ID, stage or company domain changed after provisioning; review manually.', key);
  }

  if (status) {
    if (COMPLETED_STATUSES.includes(status)) {
      return decide(IDEMPOTENCY_DECISION.SKIP_ALREADY_PROVISIONED,
        'Onboarding already provisioned for this deal (status "' + status + '"). Duplicate Closed Won transition ignored.', key);
    }
    if (status === ONBOARDING_STATUS.PROVISIONING) {
      if (isLockActive(params.lockEntry, now, ttl)) {
        return decide(IDEMPOTENCY_DECISION.SKIP_IN_FLIGHT, 'Provisioning is already in progress for this deal.', key);
      }
      return decide(IDEMPOTENCY_DECISION.BLOCK_REQUIRES_REVIEW,
        'A previous provisioning run started but never completed (status "provisioning", no active lock). Partial resources may exist; review, then clear onboarding_status to retry.', key);
    }
    if (status === ONBOARDING_STATUS.FAILED) {
      return decide(IDEMPOTENCY_DECISION.BLOCK_REQUIRES_REVIEW,
        'A previous provisioning run failed. Review partial resources, then clear onboarding_status to retry.', key);
    }
    return decide(IDEMPOTENCY_DECISION.BLOCK_REQUIRES_REVIEW, 'Unrecognised onboarding_status "' + status + '".', key);
  }

  if (isLockActive(params.lockEntry, now, ttl)) {
    return decide(IDEMPOTENCY_DECISION.SKIP_IN_FLIGHT,
      'Duplicate delivery: an in-flight lock exists for this key and the CRM write has not landed yet.', key);
  }

  return decide(IDEMPOTENCY_DECISION.PROCEED, 'No prior onboarding found for this deal; provisioning may proceed.', key);
}

/**
 * Remove expired lock entries and cap the ledger size (mutates in place,
 * because n8n workflow static data must be mutated, not replaced).
 */
function pruneLockLedger(ledger, nowMs, ttlMs, maxEntries) {
  if (!ledger || typeof ledger !== 'object') return ledger;
  for (const key of Object.keys(ledger)) {
    if (!isLockActive(ledger[key], nowMs, ttlMs)) delete ledger[key];
  }
  const keys = Object.keys(ledger);
  const limit = maxEntries || 500;
  if (keys.length > limit) {
    keys.sort((a, b) => ledger[a].lockedAt - ledger[b].lockedAt);
    for (const key of keys.slice(0, keys.length - limit)) delete ledger[key];
  }
  return ledger;
}

/**
 * Attempt to take the in-flight lock for a key. Mutates the ledger.
 * @returns {{acquired:boolean, entry:object}}
 */
function acquireInFlightLock(ledger, key, meta, nowMs, ttlMs, maxEntries) {
  if (!ledger || typeof ledger !== 'object') throw new Error('acquireInFlightLock requires a ledger object.');
  pruneLockLedger(ledger, nowMs, ttlMs, maxEntries);
  const existing = ledger[key];
  if (isLockActive(existing, nowMs, ttlMs)) return { acquired: false, entry: existing };
  const entry = Object.assign({}, meta || {}, { lockedAt: nowMs });
  ledger[key] = entry;
  return { acquired: true, entry };
}

function approvalDecision(decision, reason) {
  return { decision, allowed: decision === APPROVAL_DECISION.PROCEED, reason };
}

/**
 * Decide whether an approval-gate button press may be executed.
 * Guards against double clicks, stale buttons and replays.
 */
function evaluateApprovalDispatch(p) {
  const params = p || {};
  const status = normalizeStatus(params.onboardingStatus);
  const storedKey = String(params.storedKey || '').trim();
  const requestedKey = String(params.requestedKey || '').trim();
  const action = params.action;

  if (!isValidIdempotencyKey(requestedKey) || !storedKey || storedKey !== requestedKey) {
    return approvalDecision(APPROVAL_DECISION.BLOCK_KEY_MISMATCH,
      'The approval button does not match the onboarding record stored on the deal (stale or foreign button).');
  }
  if (action === 'approve') {
    if (status === ONBOARDING_STATUS.AWAITING_APPROVAL || status === ONBOARDING_STATUS.ON_HOLD) {
      return approvalDecision(APPROVAL_DECISION.PROCEED, 'Approval accepted.');
    }
    if (status === ONBOARDING_STATUS.CLIENT_INVITED) {
      return approvalDecision(APPROVAL_DECISION.SKIP_ALREADY_DISPATCHED, 'External invites were already dispatched for this deal.');
    }
    return approvalDecision(APPROVAL_DECISION.BLOCK_INVALID_STATE, 'Deal onboarding status "' + status + '" does not allow approval.');
  }
  if (action === 'hold') {
    if (status === ONBOARDING_STATUS.AWAITING_APPROVAL) {
      return approvalDecision(APPROVAL_DECISION.PROCEED, 'Hold accepted.');
    }
    if (status === ONBOARDING_STATUS.ON_HOLD) {
      return approvalDecision(APPROVAL_DECISION.SKIP_ALREADY_HELD, 'Onboarding is already on hold.');
    }
    if (status === ONBOARDING_STATUS.CLIENT_INVITED) {
      return approvalDecision(APPROVAL_DECISION.BLOCK_ALREADY_DISPATCHED, 'Invites were already dispatched; a hold can no longer prevent them.');
    }
    return approvalDecision(APPROVAL_DECISION.BLOCK_INVALID_STATE, 'Deal onboarding status "' + status + '" does not allow a hold.');
  }
  return approvalDecision(APPROVAL_DECISION.BLOCK_UNKNOWN_ACTION, 'Unknown approval action.');
}

module.exports = {
  IDEMPOTENCY_KEY_VERSION,
  IDEMPOTENCY_KEY_PATTERN,
  ONBOARDING_STATUS,
  IDEMPOTENCY_DECISION,
  APPROVAL_DECISION,
  deterministicHash64,
  buildIdempotencyKey,
  isValidIdempotencyKey,
  evaluateIdempotency,
  pruneLockLedger,
  acquireInFlightLock,
  evaluateApprovalDispatch
};
