#!/usr/bin/env node
'use strict';

/**
 * scripts/check-workflows.js
 * Repository validation (run in CI via `npm run check`):
 *  - workflow JSON integrity (parseable, unique node names/ids, valid connections)
 *  - every credential reference uses the REPLACE_WITH_YOUR_CREDENTIAL_ID placeholder
 *  - zero hardcoded secrets anywhere in tracked text files
 *  - generated Code-node bundles are byte-identical to a fresh build of src/
 *  - every Code node compiles; every src/ module is used by a workflow
 *  - structural SANDBOX_MODE enforcement: no mutating HTTP node is reachable
 *    from a trigger without passing through a declared live-only gate output
 *  - workflows ship inactive; sample data uses reserved example domains only
 */

const fs = require('fs');
const path = require('path');
const {
  REPO_ROOT,
  SRC_DIR,
  listSourceModules,
  readModuleSource,
  stripCommonJs,
  listWorkflowFiles,
  syncCode,
  getBundleEntryModules,
  resolveModuleOrder,
  compileCodeNode,
  isCodeNode
} = require('./lib/bundler');

const CREDENTIAL_PLACEHOLDER = 'REPLACE_WITH_YOUR_CREDENTIAL_ID';
const TRIGGER_TYPES = new Set(['n8n-nodes-base.webhook', 'n8n-nodes-base.manualTrigger', 'n8n-nodes-base.hubspotTrigger']);
const SECRET_PATTERNS = Object.freeze([
  { name: 'Slack token', pattern: /\bxox[abposr]-[0-9A-Za-z-]{10,}/ },
  { name: 'Slack incoming webhook URL', pattern: /https:\/\/hooks\.slack\.com\/services\/T[A-Z0-9]+\/B[A-Z0-9]+\/[A-Za-z0-9]{20,}/ },
  { name: 'OpenAI / Anthropic style API key', pattern: /\bsk-(?:proj-|ant-)?[A-Za-z0-9_-]{24,}/ },
  { name: 'HubSpot private app token', pattern: /\bpat-(?:na|eu|ap)\d-[0-9a-f]{8}-[0-9a-f]{4}/ },
  { name: 'Google API key', pattern: /\bAIza[0-9A-Za-z_-]{35}\b/ },
  { name: 'Google OAuth client secret', pattern: /\bGOCSPX-[A-Za-z0-9_-]{20,}/ },
  { name: 'Private key block', pattern: /-----BEGIN (?:RSA |EC |OPENSSH |DSA )?PRIVATE KEY-----/ },
  { name: 'GitHub token', pattern: /\bgh[pousr]_[A-Za-z0-9]{36,}/ },
  { name: 'ClickUp personal token', pattern: /\bpk_\d{4,}_[A-Z0-9]{20,}/ },
  { name: 'Notion integration secret', pattern: /\b(?:secret|ntn)_[A-Za-z0-9]{40,}/ },
  { name: 'AWS access key', pattern: /\bAKIA[0-9A-Z]{16}\b/ }
]);
const SCANNED_EXTENSIONS = new Set(['.js', '.json', '.md', '.yml', '.yaml', '.example', '.txt', '']);
const SKIPPED_DIRS = new Set(['.git', 'node_modules']);
const RESERVED_SAMPLE_DOMAIN = /(^|\.)example\.(com|net|org)$/;

function scanForSecrets(text) {
  const findings = [];
  for (const { name, pattern } of SECRET_PATTERNS) {
    if (pattern.test(text)) findings.push(name);
  }
  return findings;
}

function walk(dir, out) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (SKIPPED_DIRS.has(entry.name)) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full, out);
    else out.push(full);
  }
  return out;
}

/**
 * BFS over workflow connections. Edges leaving a declared sandbox gate on its
 * live output are not followed, so the result is "reachable without passing
 * through a live-only gate".
 */
function reachableWithoutLiveGates(workflow) {
  const gates = new Map();
  for (const node of workflow.nodes) {
    const match = String(node.notes || '').match(/\[sandbox-gate:live-output=(\d)\]/);
    if (match) gates.set(node.name, Number(match[1]));
  }
  const starts = workflow.nodes.filter((n) => TRIGGER_TYPES.has(n.type)).map((n) => n.name);
  const seen = new Set(starts);
  const queue = starts.slice();
  while (queue.length) {
    const name = queue.shift();
    const outputs = (workflow.connections[name] && workflow.connections[name].main) || [];
    outputs.forEach((targets, outputIndex) => {
      if (gates.has(name) && gates.get(name) === outputIndex) return;
      for (const target of targets || []) {
        if (!seen.has(target.node)) {
          seen.add(target.node);
          queue.push(target.node);
        }
      }
    });
  }
  return { reachable: seen, gates };
}

function isMutatingHttpNode(node) {
  if (node.type !== 'n8n-nodes-base.httpRequest') return false;
  const method = String(node.parameters.method || 'GET').toUpperCase();
  return method !== 'GET';
}

function checkWorkflow(file, workflow, errors, usedModules) {
  const label = path.basename(file);
  if (!workflow || typeof workflow !== 'object') return errors.push(label + ': not a JSON object.');
  if (!workflow.name) errors.push(label + ': missing workflow name.');
  if (!Array.isArray(workflow.nodes) || workflow.nodes.length === 0) return errors.push(label + ': nodes array missing or empty.');
  if (!workflow.connections || typeof workflow.connections !== 'object') errors.push(label + ': connections object missing.');
  if (workflow.active !== false) errors.push(label + ': workflows must ship with "active": false.');

  const names = new Set();
  const ids = new Set();
  for (const node of workflow.nodes) {
    if (names.has(node.name)) errors.push(label + ': duplicate node name "' + node.name + '".');
    if (ids.has(node.id)) errors.push(label + ': duplicate node id "' + node.id + '".');
    names.add(node.name);
    ids.add(node.id);
    if (!node.type || !node.parameters || !Array.isArray(node.position)) errors.push(label + ': node "' + node.name + '" is incomplete.');

    for (const [credType, cred] of Object.entries(node.credentials || {})) {
      if (!cred || cred.id !== CREDENTIAL_PLACEHOLDER) {
        errors.push(label + ': node "' + node.name + '" credential "' + credType + '" must use id ' + CREDENTIAL_PLACEHOLDER + '.');
      }
    }
    if (node.type === 'n8n-nodes-base.httpRequest' && node.parameters.authentication && !node.credentials) {
      errors.push(label + ': HTTP node "' + node.name + '" declares authentication but has no credential reference.');
    }
    for (const header of ((node.parameters.headerParameters || {}).parameters || [])) {
      if (/^(authorization|x-api-key)$/i.test(header.name)) {
        errors.push(label + ': node "' + node.name + '" sets an auth header inline; use an n8n credential instead.');
      }
    }
    if (node.type === 'n8n-nodes-base.webhook' && !node.webhookId) errors.push(label + ': webhook node "' + node.name + '" lacks a webhookId.');

    if (isCodeNode(node)) {
      const code = node.parameters.jsCode || '';
      const entries = getBundleEntryModules(code);
      if (!entries) {
        errors.push(label + ': Code node "' + node.name + '" has no GENERATED BUNDLE markers.');
        continue;
      }
      try {
        for (const m of resolveModuleOrder(entries)) usedModules.add(m);
        if (syncCode(code) !== code) {
          errors.push(label + ': Code node "' + node.name + '" is out of sync with src/. Run `npm run build`.');
        }
        compileCodeNode(code, node.name);
      } catch (error) {
        errors.push(label + ': Code node "' + node.name + '": ' + error.message);
      }
    }
  }

  for (const [from, conn] of Object.entries(workflow.connections || {})) {
    if (!names.has(from)) errors.push(label + ': connection from unknown node "' + from + '".');
    for (const targets of (conn.main || [])) {
      for (const t of targets || []) {
        if (!names.has(t.node)) errors.push(label + ': connection to unknown node "' + t.node + '".');
      }
    }
  }

  const { reachable, gates } = reachableWithoutLiveGates(workflow);
  if (gates.size === 0) errors.push(label + ': no [sandbox-gate] node declared.');
  for (const node of workflow.nodes) {
    if (!reachable.has(node.name) || !isMutatingHttpNode(node)) continue;
    if (!/\[sandbox-safe\]/.test(String(node.notes || ''))) {
      errors.push(label + ': mutating HTTP node "' + node.name + '" is reachable in SANDBOX_MODE (not behind a live-only gate and not marked [sandbox-safe]).');
    }
  }
  return errors;
}

function checkSourceModules(errors) {
  for (const name of listSourceModules()) {
    try {
      stripCommonJs(readModuleSource(name), name);
    } catch (error) {
      errors.push('src/' + name + '.js: ' + error.message);
    }
  }
}

function checkSamples(errors) {
  const dir = path.join(REPO_ROOT, 'samples');
  if (!fs.existsSync(dir)) return;
  for (const file of fs.readdirSync(dir).filter((f) => f.endsWith('.json'))) {
    const text = fs.readFileSync(path.join(dir, file), 'utf8');
    try {
      JSON.parse(text);
    } catch (error) {
      errors.push('samples/' + file + ': invalid JSON (' + error.message + ').');
      continue;
    }
    const emails = text.match(/[A-Za-z0-9._%+-]+@([A-Za-z0-9.-]+\.[A-Za-z]{2,})/g) || [];
    for (const email of emails) {
      const domain = email.split('@')[1].toLowerCase();
      if (!RESERVED_SAMPLE_DOMAIN.test(domain)) errors.push('samples/' + file + ': non-reserved email domain in sample data (' + domain + ').');
    }
  }
}

function runChecks() {
  const errors = [];
  const usedModules = new Set();
  const workflowFiles = listWorkflowFiles();
  if (workflowFiles.length < 2) errors.push('Expected at least two workflow JSON files in workflows/.');

  for (const file of workflowFiles) {
    let workflow;
    try {
      workflow = JSON.parse(fs.readFileSync(file, 'utf8'));
    } catch (error) {
      errors.push(path.basename(file) + ': invalid JSON (' + error.message + ').');
      continue;
    }
    checkWorkflow(file, workflow, errors, usedModules);
  }

  checkSourceModules(errors);
  for (const name of listSourceModules()) {
    if (!usedModules.has(name)) errors.push('src/' + name + '.js is not bundled into any workflow Code node.');
  }

  for (const file of walk(REPO_ROOT, [])) {
    const ext = path.extname(file);
    if (!SCANNED_EXTENSIONS.has(ext) && !file.endsWith('.env.example')) continue;
    if (path.basename(file) === '.env') errors.push('A .env file must never be committed.');
    const findings = scanForSecrets(fs.readFileSync(file, 'utf8'));
    for (const finding of findings) errors.push(path.relative(REPO_ROOT, file) + ': possible hardcoded secret (' + finding + ').');
  }

  checkSamples(errors);
  return { errors, workflowCount: workflowFiles.length, moduleCount: listSourceModules(SRC_DIR).length };
}

if (require.main === module) {
  const { errors, workflowCount, moduleCount } = runChecks();
  if (errors.length) {
    console.error('✖ Workflow checks failed (' + errors.length + '):');
    for (const e of errors) console.error('  - ' + e);
    process.exit(1);
  }
  console.log('✔ All checks passed: ' + workflowCount + ' workflows, ' + moduleCount + ' src modules, credentials placeholdered, no secrets, bundles in sync, sandbox gates enforced.');
}

module.exports = {
  CREDENTIAL_PLACEHOLDER,
  SECRET_PATTERNS,
  scanForSecrets,
  reachableWithoutLiveGates,
  isMutatingHttpNode,
  checkWorkflow,
  runChecks
};
