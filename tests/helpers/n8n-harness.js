'use strict';

/**
 * tests/helpers/n8n-harness.js
 * Executes n8n Code-node source (exactly as stored in workflows/*.json)
 * inside a Node.js vm context that emulates the n8n Code node globals:
 * $input, $('Node Name'), $env, $getWorkflowStaticData and this.helpers.
 */

const fs = require('fs');
const path = require('path');
const vm = require('vm');
const crypto = require('crypto');

const REPO_ROOT = path.resolve(__dirname, '..', '..');
const WF01_FILE = path.join(REPO_ROOT, 'workflows', '01-closed-won-provisioning-orchestrator.json');
const WF02_FILE = path.join(REPO_ROOT, 'workflows', '02-client-invite-approval-dispatcher.json');

const SIGNING_SECRET = 'test-signing-secret-not-real';
const HUBSPOT_SECRET = 'test-hubspot-client-secret-not-real';

const SANDBOX_ENV = Object.freeze({
  SANDBOX_MODE: 'true',
  HUBSPOT_CLOSED_WON_STAGE_ID: 'closedwon',
  SLACK_INTERNAL_APPROVAL_CHANNEL: 'C0APPROVAL1',
  SLACK_SIGNING_SECRET: SIGNING_SECRET
});

const LIVE_ENV = Object.freeze({
  SANDBOX_MODE: 'false',
  HUBSPOT_CLOSED_WON_STAGE_ID: 'closedwon',
  HUBSPOT_PORTAL_ID: '12345678',
  SLACK_INTERNAL_APPROVAL_CHANNEL: 'C0APPROVAL1',
  SLACK_INTERNAL_MEMBER_IDS: 'U0CSM00001,U0DEL00002',
  APPROVER_SLACK_USER_IDS: 'U0APPROVER1',
  SLACK_SIGNING_SECRET: SIGNING_SECRET,
  DRIVE_PARENT_FOLDER_ID: '1AbCdEfGhIjKlMnOpQr',
  WORKSPACE_PROVIDER: 'clickup',
  WORKSPACE_CONTAINER_ID: '90123456',
  ORG_DISPLAY_NAME: 'dhRobin Systems'
});

function loadWorkflow(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

function loadSample() {
  return JSON.parse(fs.readFileSync(path.join(REPO_ROOT, 'samples', 'sample-closed-won-deal.json'), 'utf8'));
}

function getNode(workflow, name) {
  const node = workflow.nodes.find((n) => n.name === name);
  if (!node) throw new Error('Node not found: ' + name);
  return node;
}

function accessor(items) {
  return {
    first: () => items[0],
    last: () => items[items.length - 1],
    all: () => items,
    item: items[0]
  };
}

/**
 * Run a Code node and return its (JSON round-tripped) output items.
 */
async function runCodeNode(workflow, nodeName, options) {
  const opts = options || {};
  const node = getNode(workflow, nodeName);
  const input = opts.input || [{ json: {} }];
  const nodeOutputs = opts.nodeOutputs || {};
  const staticData = opts.staticData || {};
  const envProxy = opts.envBlocked
    ? new Proxy({}, { get() { throw new Error('access to env vars denied'); } })
    : (opts.env || {});
  const sandbox = {
    $: (name) => {
      if (!nodeOutputs[name]) throw new Error('Harness: no output registered for node "' + name + '"');
      return accessor(nodeOutputs[name]);
    },
    $input: accessor(input),
    $env: envProxy,
    $getWorkflowStaticData: () => staticData,
    require: (moduleName) => {
      if (moduleName === 'crypto') return crypto;
      throw new Error('Module not allowed in Code node: ' + moduleName);
    },
    console,
    Buffer
  };
  const context = vm.createContext(sandbox);
  const fn = new vm.Script('(async function () {\n' + node.parameters.jsCode + '\n})').runInContext(context);
  const thisArg = {
    helpers: {
      getBinaryDataBuffer: async () => {
        if (opts.rawBody === undefined || opts.rawBody === null) throw new Error('no binary data');
        return Buffer.from(opts.rawBody, 'utf8');
      }
    }
  };
  const result = await fn.call(thisArg);
  return JSON.parse(JSON.stringify(result));
}

function hmacHex(secret, message) {
  return crypto.createHmac('sha256', secret).update(message, 'utf8').digest('hex');
}

function hmacBase64(secret, message) {
  return crypto.createHmac('sha256', secret).update(message, 'utf8').digest('base64');
}

function signSlackRequest(rawBody, secret, timestampSeconds) {
  const ts = String(timestampSeconds || Math.floor(Date.now() / 1000));
  return { timestamp: ts, signature: 'v0=' + hmacHex(secret || SIGNING_SECRET, 'v0:' + ts + ':' + rawBody) };
}

function slackInteractionBody(payload) {
  return 'payload=' + encodeURIComponent(JSON.stringify(payload));
}

function blockActionsPayload(overrides) {
  const o = overrides || {};
  return {
    type: 'block_actions',
    user: { id: o.userId || 'U0APPROVER1', username: 'approver' },
    team: { id: 'T0TEAM0001' },
    channel: { id: 'C0APPROVAL1' },
    container: { message_ts: '1793000000.000100' },
    response_url: o.responseUrl || 'https://hooks.slack.com/actions/T0TEAM0001/123456/abcdefABCDEF',
    actions: [{
      action_id: o.actionId || 'cwo_approve_external_invites',
      value: o.value !== undefined ? o.value : JSON.stringify({
        v: 1,
        dealId: o.dealId || '9876543210',
        key: o.key || 'cwo-v1-0123456789abcdef',
        clientChannelId: o.clientChannelId !== undefined ? o.clientChannelId : 'C0CLIENT01',
        sandbox: Boolean(o.sandbox)
      })
    }]
  };
}

module.exports = {
  REPO_ROOT,
  WF01_FILE,
  WF02_FILE,
  SIGNING_SECRET,
  HUBSPOT_SECRET,
  SANDBOX_ENV,
  LIVE_ENV,
  loadWorkflow,
  loadSample,
  getNode,
  runCodeNode,
  hmacHex,
  hmacBase64,
  signSlackRequest,
  slackInteractionBody,
  blockActionsPayload
};
