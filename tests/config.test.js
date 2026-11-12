'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  loadConfig,
  requireValidConfig,
  redactConfig,
  snapshotEnv,
  parseBooleanFlag,
  parseCsvList,
  CONFIG_ENV_KEYS
} = require('../src/config');
const { LIVE_ENV } = require('./helpers/n8n-harness');

test('config: SANDBOX_MODE defaults to true when unset', () => {
  const { config, ok } = loadConfig({});
  assert.equal(ok, true);
  assert.equal(config.sandboxMode, true);
});

test('config: explicit SANDBOX_MODE=false with all live requirements enables live mode', () => {
  const { config, errors } = loadConfig(LIVE_ENV);
  assert.deepEqual(errors, []);
  assert.equal(config.sandboxMode, false);
});

test('config: recognised boolean spellings are parsed case-insensitively', () => {
  for (const value of ['false', 'FALSE', '0', 'no', 'Off']) assert.equal(parseBooleanFlag(value), false, value);
  for (const value of ['true', 'TRUE', '1', 'yes', 'On']) assert.equal(parseBooleanFlag(value), true, value);
  assert.equal(parseBooleanFlag('maybe'), null);
});

test('config: unparseable SANDBOX_MODE keeps sandbox ON and reports an error', () => {
  const { config, errors, ok } = loadConfig({ SANDBOX_MODE: 'disable-please' });
  assert.equal(config.sandboxMode, true);
  assert.equal(ok, false);
  assert.match(errors[0], /SANDBOX_MODE/);
});

test('config: live mode requires Drive, workspace, internal members and approvers', () => {
  const { errors } = loadConfig({ SANDBOX_MODE: 'false' });
  const joined = errors.join('\n');
  assert.match(joined, /DRIVE_PARENT_FOLDER_ID/);
  assert.match(joined, /WORKSPACE_CONTAINER_ID/);
  assert.match(joined, /SLACK_INTERNAL_MEMBER_IDS/);
  assert.match(joined, /APPROVER_SLACK_USER_IDS/);
});

test('config: sandbox mode does not require live-only variables', () => {
  const { ok, warnings } = loadConfig({ SANDBOX_MODE: 'true' });
  assert.equal(ok, true);
  assert.ok(warnings.some((w) => /SANDBOX_MODE is enabled/.test(w)));
});

test('config: LLM provider requires a model name', () => {
  const { errors } = loadConfig({ LLM_PROVIDER: 'anthropic' });
  assert.ok(errors.some((e) => /LLM_MODEL/.test(e)));
  assert.equal(loadConfig({ LLM_PROVIDER: 'anthropic', LLM_MODEL: 'example-model' }).ok, true);
});

test('config: unsupported workspace and LLM providers are rejected', () => {
  const { errors } = loadConfig({ WORKSPACE_PROVIDER: 'trello', LLM_PROVIDER: 'mystery' });
  assert.ok(errors.some((e) => /WORKSPACE_PROVIDER/.test(e)));
  assert.ok(errors.some((e) => /LLM_PROVIDER/.test(e)));
});

test('config: allowlist invite policy requires at least one domain', () => {
  assert.equal(loadConfig({ EXTERNAL_INVITE_DOMAIN_POLICY: 'allowlist' }).ok, false);
  const { config, ok } = loadConfig({ EXTERNAL_INVITE_DOMAIN_POLICY: 'allowlist', EXTERNAL_INVITE_ALLOWED_DOMAINS: 'Example.com, example.net' });
  assert.equal(ok, true);
  assert.deepEqual(config.invites.allowedDomains, ['example.com', 'example.net']);
});

test('config: approval context requires SLACK_SIGNING_SECRET even in sandbox', () => {
  const { errors } = loadConfig({ SANDBOX_MODE: 'true' }, { context: 'approval' });
  assert.ok(errors.some((e) => /SLACK_SIGNING_SECRET/.test(e)));
});

test('config: HUBSPOT_APP_CLIENT_SECRET requires an https webhook target URL', () => {
  assert.equal(loadConfig({ HUBSPOT_APP_CLIENT_SECRET: 'x' }).ok, false);
  assert.equal(loadConfig({ HUBSPOT_APP_CLIENT_SECRET: 'x', HUBSPOT_WEBHOOK_TARGET_URL: 'https://n8n.example.com/webhook/hubspot-closed-won' }).ok, true);
});

test('config: invalid Slack user IDs are rejected', () => {
  const { errors } = loadConfig({ APPROVER_SLACK_USER_IDS: 'U0OK00001,not-a-user' });
  assert.ok(errors.some((e) => /not-a-user/.test(e)));
});

test('config: parseCsvList trims, drops empties and de-duplicates', () => {
  assert.deepEqual(parseCsvList(' a, b ,,a,c '), ['a', 'b', 'c']);
  assert.deepEqual(parseCsvList(''), []);
});

test('config: redactConfig never exposes secrets', () => {
  const { config } = loadConfig(Object.assign({}, LIVE_ENV, {
    HUBSPOT_APP_CLIENT_SECRET: 'super-secret-value',
    HUBSPOT_WEBHOOK_TARGET_URL: 'https://n8n.example.com/webhook/hubspot-closed-won'
  }));
  const serialized = JSON.stringify(redactConfig(config));
  assert.ok(!serialized.includes(LIVE_ENV.SLACK_SIGNING_SECRET));
  assert.ok(!serialized.includes('super-secret-value'));
  assert.ok(serialized.includes('[REDACTED]'));
});

test('config: snapshotEnv copies only known keys and survives a throwing $env proxy', () => {
  const { env, blocked } = snapshotEnv({ SANDBOX_MODE: 'false', UNRELATED_SECRET: 'x' });
  assert.equal(blocked, false);
  assert.deepEqual(Object.keys(env), ['SANDBOX_MODE']);
  const throwing = new Proxy({}, { get() { throw new Error('access to env vars denied'); } });
  const result = snapshotEnv(throwing);
  assert.equal(result.blocked, true);
  assert.equal(loadConfig(result.env).config.sandboxMode, true);
  assert.ok(CONFIG_ENV_KEYS.includes('SANDBOX_MODE'));
});

test('config: requireValidConfig throws one error listing every problem; config is frozen', () => {
  assert.throws(() => requireValidConfig({ SANDBOX_MODE: 'false', LLM_PROVIDER: 'openai' }), (error) => {
    return /DRIVE_PARENT_FOLDER_ID/.test(error.message) && /LLM_MODEL/.test(error.message);
  });
  const { config } = requireValidConfig({});
  assert.ok(Object.isFrozen(config));
  assert.ok(Object.isFrozen(config.slack));
  assert.ok(config.hubspot.dealProperties.includes('deal_intake_notes'));
  assert.ok(config.hubspot.dealProperties.includes('onboarding_idempotency_key'));
});
