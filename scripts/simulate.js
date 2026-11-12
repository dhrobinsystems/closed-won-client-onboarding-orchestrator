#!/usr/bin/env node
'use strict';

/**
 * scripts/simulate.js
 * Offline end-to-end dry run of the provisioning pipeline against
 * samples/sample-closed-won-deal.json (or a file passed as argv[2]).
 * No network calls are made. SANDBOX_MODE is forced on.
 *
 * Usage: npm run simulate [-- path/to/payload.json]
 * Output: summary on stdout + full artifacts in simulation-output.local.json
 */

const fs = require('fs');
const path = require('path');
const { loadConfig, redactConfig } = require('../src/config');
const { extractClosedWonDealEvents, normalizeDealPayload } = require('../src/sanitizer');
const { buildIdempotencyKey, evaluateIdempotency } = require('../src/idempotency');
const { buildProvisioningPlan, buildFallbackAgenda } = require('../src/provisioning-planner');
const { buildSandboxPreviewMessage, buildApprovalGateMessage } = require('../src/slack-blocks');

const REPO_ROOT = path.resolve(__dirname, '..');
const inputPath = path.resolve(process.argv[2] || path.join(REPO_ROOT, 'samples', 'sample-closed-won-deal.json'));
const sample = JSON.parse(fs.readFileSync(inputPath, 'utf8'));

const env = Object.assign({}, process.env, { SANDBOX_MODE: 'true' });
const { config, errors, warnings } = loadConfig(env, { context: 'provisioning' });
if (errors.length) {
  console.error('Configuration errors:\n - ' + errors.join('\n - '));
  process.exit(1);
}

const events = extractClosedWonDealEvents(sample.webhookEvents || sample, config.hubspot.closedWonStageId);
console.log('Closed-won events extracted: ' + events.length + ' (' + events.map((e) => e.dealId).join(', ') + ')');

const normalized = normalizeDealPayload(
  { deal: sample.deal, company: sample.company, contacts: sample.contacts },
  { intakeNotesProperty: config.hubspot.intakeNotesProperty }
);
if (!normalized.ok) {
  console.error('Payload validation failed:\n - ' + normalized.errors.join('\n - '));
  process.exit(1);
}

const identity = buildIdempotencyKey({
  dealId: normalized.value.deal.id,
  stageId: normalized.value.deal.stageId,
  accountDomain: normalized.value.company.domain
});
const gate = evaluateIdempotency({
  key: identity.key,
  storedKey: normalized.value.deal.storedIdempotencyKey,
  onboardingStatus: normalized.value.deal.onboardingStatus,
  nowMs: Date.now(),
  lockTtlMs: config.idempotency.lockTtlMs
});

const manifest = buildProvisioningPlan({ normalized: normalized.value, config, idempotencyKey: identity.key, now: new Date().toISOString() });
const allWarnings = warnings.concat(normalized.warnings);
const sandboxPreview = buildSandboxPreviewMessage({ manifest, idempotency: gate, warnings: allWarnings });
const approvalGatePreview = buildApprovalGateMessage({
  manifest,
  provisioned: { channelId: 'C0SIMULATED', driveFolderUrl: '', workspaceUrl: '', tasksCreated: manifest.workspace.tasks.length },
  agenda: { source: 'fallback', agenda: buildFallbackAgenda(manifest.kickoff.prompt.groundingFacts), issues: ['simulation'] }
});

console.log('Idempotency: ' + gate.decision + ' (' + identity.key + ')');
console.log('Slack channel: #' + manifest.slack.channelName);
console.log('Drive tree:    ' + manifest.drive.rootFolderName + ' / ' + manifest.drive.subfolders.map((f) => f.name).join(', '));
console.log('Workspace:     ' + manifest.workspace.provider + ' -> ' + manifest.workspace.projectName + ' (' + manifest.workspace.tasks.length + ' tasks)');
console.log('Invites:       ' + manifest.externalInvites.invite.map((i) => i.email).join(', '));
console.log('Blocked:       ' + manifest.externalInvites.rejected.map((r) => r.email + ' [' + r.reason + ']').join(', '));
if (allWarnings.length) console.log('Warnings:\n - ' + allWarnings.join('\n - '));

const outFile = path.join(REPO_ROOT, 'simulation-output.local.json');
fs.writeFileSync(outFile, JSON.stringify({ config: redactConfig(config), events, gate, manifest, sandboxPreview, approvalGatePreview }, null, 2) + '\n');
console.log('\nFull manifest and Slack Block Kit payloads written to ' + path.relative(process.cwd(), outFile));
console.log('Paste a payload into https://app.slack.com/block-kit-builder to preview it.');
