'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  buildIdempotencyKey,
  isValidIdempotencyKey,
  evaluateIdempotency,
  acquireInFlightLock,
  pruneLockLedger,
  evaluateApprovalDispatch,
  deterministicHash64,
  IDEMPOTENCY_DECISION,
  APPROVAL_DECISION
} = require('../src/idempotency');

const BASE = { dealId: '9876543210', stageId: 'closedwon', accountDomain: 'example-business.example.com' };
const KEY = buildIdempotencyKey(BASE).key;
const NOW = 1_800_000_000_000;
const TTL = 15 * 60 * 1000;

test('idempotency: key is deterministic for identical inputs', () => {
  assert.equal(buildIdempotencyKey(BASE).key, buildIdempotencyKey(Object.assign({}, BASE)).key);
  assert.equal(deterministicHash64('abc'), deterministicHash64('abc'));
});

test('idempotency: key normalizes the account domain (URL, case, www)', () => {
  const variant = buildIdempotencyKey(Object.assign({}, BASE, { accountDomain: 'https://www.Example-Business.example.com/' }));
  assert.equal(variant.key, KEY);
  assert.equal(variant.canonical, 'v1|9876543210|closedwon|example-business.example.com');
});

test('idempotency: any change in deal, stage or domain yields a different key', () => {
  const keys = new Set([
    KEY,
    buildIdempotencyKey(Object.assign({}, BASE, { dealId: '9876543211' })).key,
    buildIdempotencyKey(Object.assign({}, BASE, { stageId: 'closedwon2' })).key,
    buildIdempotencyKey(Object.assign({}, BASE, { accountDomain: 'other.example.com' })).key
  ]);
  assert.equal(keys.size, 4);
});

test('idempotency: key format is cwo-v1-<16 hex>', () => {
  assert.match(KEY, /^cwo-v1-[a-f0-9]{16}$/);
  assert.equal(isValidIdempotencyKey(KEY), true);
  assert.equal(isValidIdempotencyKey('cwo-v1-xyz'), false);
});

test('idempotency: missing or invalid components throw', () => {
  assert.throws(() => buildIdempotencyKey({ stageId: 'closedwon', accountDomain: 'example.com' }), /dealId/);
  assert.throws(() => buildIdempotencyKey({ dealId: '1', stageId: 'closedwon', accountDomain: 'not a domain' }), /domain/);
});

test('idempotency: no collisions across 20,000 distinct deal/domain combinations', () => {
  const seen = new Set();
  for (let deal = 0; deal < 2000; deal += 1) {
    for (let d = 0; d < 10; d += 1) {
      seen.add(buildIdempotencyKey({ dealId: String(1000000 + deal), stageId: 'closedwon', accountDomain: 'client' + d + '.example.com' }).key);
    }
  }
  assert.equal(seen.size, 20000);
});

test('idempotency: a fresh deal with no CRM state proceeds', () => {
  const result = evaluateIdempotency({ key: KEY, storedKey: '', onboardingStatus: '', nowMs: NOW });
  assert.equal(result.decision, IDEMPOTENCY_DECISION.PROCEED);
  assert.equal(result.shouldProvision, true);
});

test('idempotency: deal toggled out of and back into Closed Won is skipped', () => {
  for (const status of ['awaiting_approval', 'on_hold', 'client_invited', 'AWAITING_APPROVAL']) {
    const result = evaluateIdempotency({ key: KEY, storedKey: KEY, onboardingStatus: status, nowMs: NOW });
    assert.equal(result.decision, IDEMPOTENCY_DECISION.SKIP_ALREADY_PROVISIONED, status);
    assert.equal(result.shouldProvision, false);
  }
});

test('idempotency: concurrent duplicate delivery is skipped while the lock is active', () => {
  const ledger = {};
  assert.equal(acquireInFlightLock(ledger, KEY, { dealId: '1' }, NOW, TTL).acquired, true);
  const second = evaluateIdempotency({ key: KEY, storedKey: '', onboardingStatus: '', lockEntry: ledger[KEY], nowMs: NOW + 2000, lockTtlMs: TTL });
  assert.equal(second.decision, IDEMPOTENCY_DECISION.SKIP_IN_FLIGHT);
  const withCrm = evaluateIdempotency({ key: KEY, storedKey: KEY, onboardingStatus: 'provisioning', lockEntry: ledger[KEY], nowMs: NOW + 2000, lockTtlMs: TTL });
  assert.equal(withCrm.decision, IDEMPOTENCY_DECISION.SKIP_IN_FLIGHT);
});

test('idempotency: a stale "provisioning" status requires human review (no blind retry)', () => {
  const result = evaluateIdempotency({ key: KEY, storedKey: KEY, onboardingStatus: 'provisioning', lockEntry: { lockedAt: NOW - TTL - 1 }, nowMs: NOW, lockTtlMs: TTL });
  assert.equal(result.decision, IDEMPOTENCY_DECISION.BLOCK_REQUIRES_REVIEW);
});

test('idempotency: failed and unknown statuses require review', () => {
  assert.equal(evaluateIdempotency({ key: KEY, storedKey: KEY, onboardingStatus: 'failed', nowMs: NOW }).decision, IDEMPOTENCY_DECISION.BLOCK_REQUIRES_REVIEW);
  assert.equal(evaluateIdempotency({ key: KEY, storedKey: KEY, onboardingStatus: 'weird', nowMs: NOW }).decision, IDEMPOTENCY_DECISION.BLOCK_REQUIRES_REVIEW);
});

test('idempotency: a different stored key (e.g. domain edited after provisioning) is a conflict', () => {
  const other = buildIdempotencyKey(Object.assign({}, BASE, { accountDomain: 'renamed.example.com' })).key;
  const result = evaluateIdempotency({ key: other, storedKey: KEY, onboardingStatus: 'awaiting_approval', nowMs: NOW });
  assert.equal(result.decision, IDEMPOTENCY_DECISION.BLOCK_KEY_CONFLICT);
});

test('idempotency: expired locks are ignored once the CRM is the source of truth', () => {
  const result = evaluateIdempotency({ key: KEY, storedKey: '', onboardingStatus: '', lockEntry: { lockedAt: NOW - TTL }, nowMs: NOW, lockTtlMs: TTL });
  assert.equal(result.decision, IDEMPOTENCY_DECISION.PROCEED);
});

test('idempotency: in-flight lock cannot be acquired twice until TTL expiry', () => {
  const ledger = {};
  assert.equal(acquireInFlightLock(ledger, KEY, {}, NOW, TTL).acquired, true);
  assert.equal(acquireInFlightLock(ledger, KEY, {}, NOW + 1000, TTL).acquired, false);
  assert.equal(acquireInFlightLock(ledger, KEY, {}, NOW + TTL + 1, TTL).acquired, true);
  assert.throws(() => acquireInFlightLock(null, KEY, {}, NOW, TTL), /ledger/);
});

test('idempotency: ledger pruning removes expired entries and caps size', () => {
  const ledger = { old: { lockedAt: NOW - TTL * 2 } };
  for (let i = 0; i < 10; i += 1) ledger['k' + i] = { lockedAt: NOW - i };
  pruneLockLedger(ledger, NOW, TTL, 5);
  assert.equal(ledger.old, undefined);
  assert.equal(Object.keys(ledger).length, 5);
  assert.ok(ledger.k0 && !ledger.k9, 'newest entries are kept');
});

test('idempotency: end-to-end deal toggle scenario provisions exactly once', () => {
  const crm = { storedKey: '', status: '' };
  const ledger = {};
  let provisioned = 0;
  const transitions = ['closedwon', 'contractsent', 'closedwon', 'closedwon'];
  transitions.forEach((stage, index) => {
    if (stage !== 'closedwon') return;
    const key = buildIdempotencyKey(Object.assign({}, BASE, { stageId: stage })).key;
    const now = NOW + index * TTL * 2;
    const gate = evaluateIdempotency({ key, storedKey: crm.storedKey, onboardingStatus: crm.status, lockEntry: ledger[key], nowMs: now, lockTtlMs: TTL });
    if (gate.shouldProvision && acquireInFlightLock(ledger, key, {}, now, TTL).acquired) {
      provisioned += 1;
      crm.storedKey = key;
      crm.status = 'awaiting_approval';
    }
  });
  assert.equal(provisioned, 1);
});

test('idempotency: approval dispatch matrix guards double clicks and stale buttons', () => {
  const run = (action, status, requestedKey, storedKey) => evaluateApprovalDispatch({ action, onboardingStatus: status, requestedKey: requestedKey || KEY, storedKey: storedKey === undefined ? KEY : storedKey }).decision;
  assert.equal(run('approve', 'awaiting_approval'), APPROVAL_DECISION.PROCEED);
  assert.equal(run('approve', 'on_hold'), APPROVAL_DECISION.PROCEED);
  assert.equal(run('approve', 'client_invited'), APPROVAL_DECISION.SKIP_ALREADY_DISPATCHED);
  assert.equal(run('approve', 'provisioning'), APPROVAL_DECISION.BLOCK_INVALID_STATE);
  assert.equal(run('hold', 'awaiting_approval'), APPROVAL_DECISION.PROCEED);
  assert.equal(run('hold', 'on_hold'), APPROVAL_DECISION.SKIP_ALREADY_HELD);
  assert.equal(run('hold', 'client_invited'), APPROVAL_DECISION.BLOCK_ALREADY_DISPATCHED);
  assert.equal(run('approve', 'awaiting_approval', KEY, ''), APPROVAL_DECISION.BLOCK_KEY_MISMATCH);
  assert.equal(run('approve', 'awaiting_approval', 'cwo-v1-ffffffffffffffff'), APPROVAL_DECISION.BLOCK_KEY_MISMATCH);
  assert.equal(run('delete', 'awaiting_approval'), APPROVAL_DECISION.BLOCK_UNKNOWN_ACTION);
});

test('idempotency: evaluateIdempotency rejects malformed keys', () => {
  assert.throws(() => evaluateIdempotency({ key: 'bogus', nowMs: NOW }), /valid key/);
});
