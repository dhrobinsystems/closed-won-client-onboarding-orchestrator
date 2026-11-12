'use strict';

/**
 * src/config.js
 * Environment variable parser & validator.
 *
 * Pure module: it never reads process.env or $env directly. Callers pass a
 * plain env object (see snapshotEnv) so the same code runs identically inside
 * n8n Code nodes, the Node.js test runner, and local simulation scripts.
 *
 * Safety contract: SANDBOX_MODE is ON unless it is explicitly set to a
 * recognised "false" value. Any unparseable value keeps sandbox ON and is
 * reported as an error.
 */

const CONFIG_ENV_KEYS = Object.freeze([
  'SANDBOX_MODE',
  'HUBSPOT_CLOSED_WON_STAGE_ID',
  'HUBSPOT_PIPELINE_ID',
  'HUBSPOT_PORTAL_ID',
  'HUBSPOT_INTAKE_NOTES_PROPERTY',
  'HUBSPOT_APP_CLIENT_SECRET',
  'HUBSPOT_WEBHOOK_TARGET_URL',
  'SLACK_INTERNAL_APPROVAL_CHANNEL',
  'SLACK_CHANNEL_PREFIX',
  'SLACK_PRIVATE_CHANNELS',
  'SLACK_INTERNAL_MEMBER_IDS',
  'APPROVER_SLACK_USER_IDS',
  'SLACK_SIGNING_SECRET',
  'SLACK_SIGNATURE_TOLERANCE_SECONDS',
  'DRIVE_PARENT_FOLDER_ID',
  'WORKSPACE_PROVIDER',
  'WORKSPACE_CONTAINER_ID',
  'LLM_PROVIDER',
  'LLM_MODEL',
  'LLM_MAX_TOKENS',
  'LLM_TEMPERATURE',
  'EXTERNAL_INVITE_DOMAIN_POLICY',
  'EXTERNAL_INVITE_ALLOWED_DOMAINS',
  'MAX_EXTERNAL_INVITES',
  'ORG_DISPLAY_NAME',
  'IDEMPOTENCY_LOCK_TTL_MINUTES'
]);

const SUPPORTED_WORKSPACE_PROVIDERS = Object.freeze(['clickup', 'asana', 'notion']);
const SUPPORTED_LLM_PROVIDERS = Object.freeze(['none', 'openai', 'anthropic']);
const SUPPORTED_INVITE_POLICIES = Object.freeze(['match_company_domain', 'allowlist']);
const CONFIG_CONTEXTS = Object.freeze(['provisioning', 'approval']);

const HUBSPOT_ONBOARDING_PROPERTIES = Object.freeze({
  status: 'onboarding_status',
  idempotencyKey: 'onboarding_idempotency_key',
  slackChannelId: 'onboarding_slack_channel_id',
  driveFolderUrl: 'onboarding_drive_folder_url',
  workspaceUrl: 'onboarding_workspace_url'
});

const HUBSPOT_BASE_DEAL_PROPERTIES = Object.freeze([
  'dealname',
  'dealstage',
  'pipeline',
  'amount',
  'deal_currency_code',
  'closedate',
  'hubspot_owner_id'
]);

const SLACK_CHANNEL_REF_PATTERN = /^([CG][A-Z0-9]{6,}|#?[a-z0-9][a-z0-9._-]{0,79})$/;
const SLACK_USER_ID_PATTERN = /^[UW][A-Z0-9]{2,}$/;
const HUBSPOT_PROPERTY_NAME_PATTERN = /^[a-z][a-z0-9_]{0,99}$/;

function parseBooleanFlag(value) {
  const normalized = String(value).trim().toLowerCase();
  if (['true', '1', 'yes', 'on'].includes(normalized)) return true;
  if (['false', '0', 'no', 'off'].includes(normalized)) return false;
  return null;
}

function parseIntegerInRange(raw, fallback, min, max) {
  if (raw === '') return { value: fallback, error: null };
  if (!/^-?\d+$/.test(raw)) return { value: fallback, error: 'must be an integer' };
  const value = Number(raw);
  if (value < min || value > max) {
    return { value: fallback, error: 'must be between ' + min + ' and ' + max };
  }
  return { value, error: null };
}

function parseCsvList(raw) {
  if (!raw) return [];
  const seen = new Set();
  const out = [];
  for (const part of String(raw).split(',')) {
    const item = part.trim();
    if (item && !seen.has(item)) {
      seen.add(item);
      out.push(item);
    }
  }
  return out;
}

function deepFreeze(value) {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const key of Object.keys(value)) deepFreeze(value[key]);
  }
  return value;
}

/**
 * Copy only the known configuration keys out of an env-like source.
 * Works with n8n's $env proxy, which may throw when env access is blocked.
 */
function snapshotEnv(source) {
  const env = {};
  let blocked = false;
  if (!source || (typeof source !== 'object' && typeof source !== 'function')) {
    return { env, blocked };
  }
  for (const key of CONFIG_ENV_KEYS) {
    try {
      const value = source[key];
      if (value !== undefined && value !== null) env[key] = String(value);
    } catch (error) {
      blocked = true;
    }
  }
  return { env, blocked };
}

/**
 * Parse and validate configuration.
 * @param {Record<string,string>} env plain object of environment variables
 * @param {{context?: 'provisioning'|'approval'}} [options]
 * @returns {{config: object, errors: string[], warnings: string[], ok: boolean}}
 */
function loadConfig(env, options) {
  const source = env || {};
  const context = (options && options.context) || 'provisioning';
  if (!CONFIG_CONTEXTS.includes(context)) {
    throw new Error('Unknown config context: ' + context);
  }
  const errors = [];
  const warnings = [];
  const read = (key) => {
    const value = source[key];
    return value === undefined || value === null ? '' : String(value).trim();
  };

  // --- Sandbox (fail-safe) -------------------------------------------------
  let sandboxMode = true;
  const rawSandbox = read('SANDBOX_MODE');
  if (rawSandbox !== '') {
    const parsed = parseBooleanFlag(rawSandbox);
    if (parsed === null) {
      errors.push('SANDBOX_MODE must be "true" or "false" (got "' + rawSandbox + '"); sandbox remains ENABLED.');
    } else {
      sandboxMode = parsed;
    }
  }

  // --- HubSpot -------------------------------------------------------------
  const closedWonStageId = read('HUBSPOT_CLOSED_WON_STAGE_ID') || 'closedwon';
  const pipelineId = read('HUBSPOT_PIPELINE_ID');
  const portalId = read('HUBSPOT_PORTAL_ID');
  if (portalId && !/^\d{1,20}$/.test(portalId)) errors.push('HUBSPOT_PORTAL_ID must be numeric.');
  const intakeNotesProperty = read('HUBSPOT_INTAKE_NOTES_PROPERTY') || 'deal_intake_notes';
  if (!HUBSPOT_PROPERTY_NAME_PATTERN.test(intakeNotesProperty)) {
    errors.push('HUBSPOT_INTAKE_NOTES_PROPERTY must be a HubSpot internal property name (lowercase, digits, underscores).');
  }
  const appClientSecret = read('HUBSPOT_APP_CLIENT_SECRET');
  const webhookTargetUrl = read('HUBSPOT_WEBHOOK_TARGET_URL');
  if (appClientSecret && !/^https:\/\/\S+$/.test(webhookTargetUrl)) {
    errors.push('HUBSPOT_WEBHOOK_TARGET_URL (https) is required when HUBSPOT_APP_CLIENT_SECRET is set, because HubSpot v3 signatures cover the exact URL.');
  }

  // --- Slack ---------------------------------------------------------------
  const approvalChannel = read('SLACK_INTERNAL_APPROVAL_CHANNEL') || '#cs-handoffs';
  if (!SLACK_CHANNEL_REF_PATTERN.test(approvalChannel)) {
    errors.push('SLACK_INTERNAL_APPROVAL_CHANNEL must be a channel ID (e.g. C0123ABCD) or a #channel-name.');
  }
  const channelPrefixRaw = read('SLACK_CHANNEL_PREFIX') || 'client';
  const channelPrefix = channelPrefixRaw.toLowerCase();
  if (!/^[a-z0-9][a-z0-9_-]{0,19}$/.test(channelPrefix)) {
    errors.push('SLACK_CHANNEL_PREFIX must be 1-20 chars of lowercase letters, digits, hyphens or underscores.');
  }
  let privateChannels = true;
  const rawPrivate = read('SLACK_PRIVATE_CHANNELS');
  if (rawPrivate !== '') {
    const parsed = parseBooleanFlag(rawPrivate);
    if (parsed === null) errors.push('SLACK_PRIVATE_CHANNELS must be "true" or "false".');
    else privateChannels = parsed;
  }
  const internalMemberIds = parseCsvList(read('SLACK_INTERNAL_MEMBER_IDS'));
  const approverIds = parseCsvList(read('APPROVER_SLACK_USER_IDS'));
  for (const id of internalMemberIds) {
    if (!SLACK_USER_ID_PATTERN.test(id)) errors.push('SLACK_INTERNAL_MEMBER_IDS contains an invalid Slack user ID: ' + id);
  }
  for (const id of approverIds) {
    if (!SLACK_USER_ID_PATTERN.test(id)) errors.push('APPROVER_SLACK_USER_IDS contains an invalid Slack user ID: ' + id);
  }
  const signingSecret = read('SLACK_SIGNING_SECRET');
  const tolerance = parseIntegerInRange(read('SLACK_SIGNATURE_TOLERANCE_SECONDS'), 300, 30, 900);
  if (tolerance.error) errors.push('SLACK_SIGNATURE_TOLERANCE_SECONDS ' + tolerance.error + '.');

  // --- Google Drive --------------------------------------------------------
  const driveParentFolderId = read('DRIVE_PARENT_FOLDER_ID');
  if (driveParentFolderId && !/^[A-Za-z0-9_-]{10,128}$/.test(driveParentFolderId)) {
    errors.push('DRIVE_PARENT_FOLDER_ID does not look like a Google Drive folder ID.');
  }

  // --- Workspace provider --------------------------------------------------
  const workspaceProvider = (read('WORKSPACE_PROVIDER') || 'clickup').toLowerCase();
  if (!SUPPORTED_WORKSPACE_PROVIDERS.includes(workspaceProvider)) {
    errors.push('WORKSPACE_PROVIDER must be one of: ' + SUPPORTED_WORKSPACE_PROVIDERS.join(', ') + '.');
  }
  const workspaceContainerId = read('WORKSPACE_CONTAINER_ID');
  if (workspaceContainerId && !/^[A-Za-z0-9_-]{1,128}$/.test(workspaceContainerId)) {
    errors.push('WORKSPACE_CONTAINER_ID contains unsupported characters.');
  }

  // --- LLM -----------------------------------------------------------------
  const llmProvider = (read('LLM_PROVIDER') || 'none').toLowerCase();
  if (!SUPPORTED_LLM_PROVIDERS.includes(llmProvider)) {
    errors.push('LLM_PROVIDER must be one of: ' + SUPPORTED_LLM_PROVIDERS.join(', ') + '.');
  }
  const llmModel = read('LLM_MODEL');
  const maxTokens = parseIntegerInRange(read('LLM_MAX_TOKENS'), 1200, 200, 8000);
  if (maxTokens.error) errors.push('LLM_MAX_TOKENS ' + maxTokens.error + '.');
  let temperature = null;
  const rawTemperature = read('LLM_TEMPERATURE');
  if (rawTemperature !== '') {
    const t = Number(rawTemperature);
    if (!Number.isFinite(t) || t < 0 || t > 1) errors.push('LLM_TEMPERATURE must be a number between 0 and 1.');
    else temperature = t;
  }
  if (llmProvider !== 'none' && !llmModel) {
    errors.push('LLM_MODEL is required when LLM_PROVIDER is "' + llmProvider + '".');
  }

  // --- External invite safety ---------------------------------------------
  const invitePolicy = (read('EXTERNAL_INVITE_DOMAIN_POLICY') || 'match_company_domain').toLowerCase();
  if (!SUPPORTED_INVITE_POLICIES.includes(invitePolicy)) {
    errors.push('EXTERNAL_INVITE_DOMAIN_POLICY must be one of: ' + SUPPORTED_INVITE_POLICIES.join(', ') + '.');
  }
  const allowedDomains = parseCsvList(read('EXTERNAL_INVITE_ALLOWED_DOMAINS').toLowerCase());
  if (invitePolicy === 'allowlist' && allowedDomains.length === 0) {
    errors.push('EXTERNAL_INVITE_ALLOWED_DOMAINS must list at least one domain when EXTERNAL_INVITE_DOMAIN_POLICY=allowlist.');
  }
  const maxInvites = parseIntegerInRange(read('MAX_EXTERNAL_INVITES'), 10, 1, 50);
  if (maxInvites.error) errors.push('MAX_EXTERNAL_INVITES ' + maxInvites.error + '.');

  // --- Misc ----------------------------------------------------------------
  const orgDisplayName = (read('ORG_DISPLAY_NAME') || 'Our Team').slice(0, 80);
  const lockTtl = parseIntegerInRange(read('IDEMPOTENCY_LOCK_TTL_MINUTES'), 15, 1, 1440);
  if (lockTtl.error) errors.push('IDEMPOTENCY_LOCK_TTL_MINUTES ' + lockTtl.error + '.');

  // --- Mode/context-specific requirements ---------------------------------
  if (!sandboxMode) {
    if (context === 'provisioning') {
      if (!driveParentFolderId) errors.push('DRIVE_PARENT_FOLDER_ID is required when SANDBOX_MODE=false.');
      if (!workspaceContainerId) errors.push('WORKSPACE_CONTAINER_ID is required when SANDBOX_MODE=false.');
      if (internalMemberIds.length === 0) {
        errors.push('SLACK_INTERNAL_MEMBER_IDS must list at least one internal Slack user when SANDBOX_MODE=false (bot-created channels have no human members otherwise).');
      }
    }
    if (approverIds.length === 0) {
      errors.push('APPROVER_SLACK_USER_IDS must list at least one approver when SANDBOX_MODE=false.');
    }
    if (!appClientSecret && context === 'provisioning') {
      warnings.push('HUBSPOT_APP_CLIENT_SECRET is not set: inbound HubSpot webhook signatures are not verified. Deal data is still re-fetched from the HubSpot API before any action.');
    }
  } else {
    warnings.push('SANDBOX_MODE is enabled: no channels, folders, projects, invites or CRM writes will be executed.');
    if (approverIds.length === 0) {
      warnings.push('APPROVER_SLACK_USER_IDS is empty: any workspace user may click sandbox approval buttons.');
    }
  }
  if (context === 'approval' && !signingSecret) {
    errors.push('SLACK_SIGNING_SECRET is required for the approval dispatcher (signatures are verified in every mode).');
  }

  const dealProperties = HUBSPOT_BASE_DEAL_PROPERTIES.concat(
    Object.values(HUBSPOT_ONBOARDING_PROPERTIES),
    [intakeNotesProperty]
  );

  const config = {
    context,
    sandboxMode,
    hubspot: {
      closedWonStageId,
      pipelineId,
      portalId,
      intakeNotesProperty,
      appClientSecret,
      webhookTargetUrl,
      properties: Object.assign({}, HUBSPOT_ONBOARDING_PROPERTIES),
      dealProperties: Array.from(new Set(dealProperties))
    },
    slack: {
      approvalChannel,
      channelPrefix,
      privateChannels,
      internalMemberIds,
      approverIds,
      signingSecret,
      signatureToleranceSeconds: tolerance.value
    },
    drive: {
      parentFolderId: driveParentFolderId
    },
    workspace: {
      provider: workspaceProvider,
      containerId: workspaceContainerId
    },
    llm: {
      provider: llmProvider,
      model: llmModel,
      maxTokens: maxTokens.value,
      temperature
    },
    invites: {
      policy: invitePolicy,
      allowedDomains,
      maxPerDeal: maxInvites.value
    },
    org: {
      displayName: orgDisplayName
    },
    idempotency: {
      lockTtlMs: lockTtl.value * 60 * 1000,
      ledgerMaxEntries: 500
    }
  };

  return { config: deepFreeze(config), errors, warnings, ok: errors.length === 0 };
}

/**
 * Like loadConfig, but throws a single descriptive Error when invalid.
 */
function requireValidConfig(env, options) {
  const result = loadConfig(env, options);
  if (!result.ok) {
    throw new Error('Invalid configuration:\n - ' + result.errors.join('\n - '));
  }
  return result;
}

/**
 * Safe-to-log copy of the config: secrets are replaced, never echoed.
 */
function redactConfig(config) {
  const copy = JSON.parse(JSON.stringify(config));
  if (copy.slack) copy.slack.signingSecret = copy.slack.signingSecret ? '[REDACTED]' : '';
  if (copy.hubspot) copy.hubspot.appClientSecret = copy.hubspot.appClientSecret ? '[REDACTED]' : '';
  return copy;
}

module.exports = {
  CONFIG_ENV_KEYS,
  SUPPORTED_WORKSPACE_PROVIDERS,
  SUPPORTED_LLM_PROVIDERS,
  SUPPORTED_INVITE_POLICIES,
  HUBSPOT_ONBOARDING_PROPERTIES,
  parseBooleanFlag,
  parseCsvList,
  snapshotEnv,
  loadConfig,
  requireValidConfig,
  redactConfig
};
