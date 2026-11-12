'use strict';

/**
 * src/slack-blocks.js
 * Slack Block Kit payload builders:
 *  1) Internal #cs-handoffs provisioning summary + Human-in-the-Loop approval
 *     gate (Approve External Invites / Hold).
 *  2) Sandbox dry-run previews when SANDBOX_MODE=true.
 *  3) Client welcome packet, approval outcome notices and rejections.
 * All user-supplied text is escaped for Slack mrkdwn.
 */

const SLACK_ACTION_IDS = Object.freeze({
  APPROVE: 'cwo_approve_external_invites',
  HOLD: 'cwo_hold_onboarding'
});

const SLACK_SECTION_TEXT_LIMIT = 3000;
const SLACK_BUTTON_VALUE_LIMIT = 2000;
const SLACK_MAX_BLOCKS = 50;

function escapeMrkdwn(value) {
  return String(value === undefined || value === null ? '' : value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

function truncateText(value, limit) {
  const text = String(value || '');
  const max = limit || SLACK_SECTION_TEXT_LIMIT;
  return text.length <= max ? text : text.slice(0, max - 1) + '\u2026';
}

/**
 * Convert the subset of Markdown produced by the agenda builders into
 * Slack mrkdwn (headings and bold), escaping everything else.
 */
function markdownToMrkdwn(markdown) {
  return String(markdown || '')
    .split('\n')
    .map((line) => {
      const escaped = escapeMrkdwn(line);
      const heading = escaped.match(/^#{1,6}\s+(.*)$/);
      if (heading) return '*' + heading[1].replace(/\*/g, '') + '*';
      return escaped.replace(/\*\*(.+?)\*\*/g, '*$1*').replace(/^(\s*)[-*]\s+/, '$1\u2022 ');
    })
    .join('\n');
}

function formatMoney(amount, currency) {
  if (!Number.isFinite(amount)) return 'Not set';
  try {
    return new Intl.NumberFormat('en-US', { style: 'currency', currency: currency || 'USD', maximumFractionDigits: 0 }).format(amount);
  } catch (error) {
    return (currency || 'USD') + ' ' + Math.round(amount).toLocaleString('en-US');
  }
}

function linkOrText(url, label) {
  if (url && /^https:\/\/[^\s|<>]+$/.test(url)) return '<' + url + '|' + escapeMrkdwn(label) + '>';
  return escapeMrkdwn(label);
}

function section(text) {
  return { type: 'section', text: { type: 'mrkdwn', text: truncateText(text) } };
}

function fieldsSection(fields) {
  return { type: 'section', fields: fields.slice(0, 10).map((f) => ({ type: 'mrkdwn', text: truncateText(f, 2000) })) };
}

function contextBlock(texts) {
  return { type: 'context', elements: texts.slice(0, 10).map((t) => ({ type: 'mrkdwn', text: truncateText(t, 2000) })) };
}

function capBlocks(blocks) {
  return blocks.length <= SLACK_MAX_BLOCKS ? blocks : blocks.slice(0, SLACK_MAX_BLOCKS);
}

/**
 * Serialize the minimal, non-sensitive state carried by the approval buttons.
 * The dispatcher re-validates all of it against HubSpot before acting.
 */
function buildApprovalButtonValue(params) {
  const p = params || {};
  const value = JSON.stringify({
    v: 1,
    dealId: String(p.dealId || ''),
    key: String(p.idempotencyKey || ''),
    clientChannelId: String(p.clientChannelId || ''),
    sandbox: Boolean(p.sandbox)
  });
  if (value.length > SLACK_BUTTON_VALUE_LIMIT) throw new Error('Approval button value exceeds Slack limit.');
  return value;
}

function approvalActionsBlock(params) {
  const value = buildApprovalButtonValue(params);
  const sandbox = Boolean(params && params.sandbox);
  return {
    type: 'actions',
    block_id: 'cwo_approval_gate',
    elements: [
      {
        type: 'button',
        action_id: SLACK_ACTION_IDS.APPROVE,
        style: 'primary',
        text: { type: 'plain_text', text: sandbox ? '(Sandbox) Approve External Invites' : 'Approve External Invites', emoji: true },
        value,
        confirm: {
          title: { type: 'plain_text', text: 'Invite client contacts?' },
          text: { type: 'mrkdwn', text: sandbox ? 'Sandbox mode: this only produces a dry-run preview.' : 'This sends Slack Connect invitations to the listed external client emails and posts the welcome packet.' },
          confirm: { type: 'plain_text', text: sandbox ? 'Run preview' : 'Send invites' },
          deny: { type: 'plain_text', text: 'Cancel' }
        }
      },
      {
        type: 'button',
        action_id: SLACK_ACTION_IDS.HOLD,
        style: 'danger',
        text: { type: 'plain_text', text: sandbox ? '(Sandbox) Hold' : 'Hold', emoji: true },
        value
      }
    ]
  };
}

function invitePlanLines(invitePlan) {
  const plan = invitePlan || { invite: [], rejected: [] };
  const lines = [];
  if (plan.invite.length === 0) lines.push('_No eligible external contacts. Nothing will be sent._');
  for (const i of plan.invite) lines.push('\u2022 ' + escapeMrkdwn(i.name) + ' \u2014 `' + escapeMrkdwn(i.email) + '`');
  for (const r of plan.rejected) lines.push('\u2022 ~' + escapeMrkdwn(r.email || '(no email)') + '~ \u2014 blocked: ' + escapeMrkdwn(r.reason));
  return lines.join('\n');
}

function dealFields(manifest) {
  return [
    '*Company*\n' + escapeMrkdwn(manifest.company.name) + ' (`' + escapeMrkdwn(manifest.company.domain) + '`)',
    '*Deal*\n' + linkOrText(manifest.deal.url, manifest.deal.name),
    '*Amount*\n' + formatMoney(manifest.deal.amount, manifest.deal.currency),
    '*Close date*\n' + escapeMrkdwn(manifest.deal.closeDate ? manifest.deal.closeDate.slice(0, 10) : 'Not set')
  ];
}

/**
 * Internal approval gate posted to #cs-handoffs after live provisioning.
 */
function buildApprovalGateMessage(params) {
  const p = params || {};
  const m = p.manifest;
  if (!m) throw new Error('buildApprovalGateMessage requires a manifest.');
  const r = p.provisioned || {};
  const agenda = p.agenda || { source: 'fallback', agenda: '', issues: [] };
  const approvers = (m.approval.approverIds || []).map((id) => '<@' + id + '>').join(', ') || '_any member_';

  const blocks = [
    { type: 'header', text: { type: 'plain_text', text: 'Closed Won \u2192 Client onboarding provisioned', emoji: true } },
    fieldsSection(dealFields(m)),
    section('*Provisioned resources*\n'
      + '\u2022 Slack: ' + (r.channelId ? '<#' + r.channelId + '>' : '`#' + escapeMrkdwn(m.slack.channelName) + '`') + (m.slack.isPrivate ? ' (private)' : '') + '\n'
      + '\u2022 Google Drive: ' + linkOrText(r.driveFolderUrl, m.drive.rootFolderName) + ' (' + m.drive.subfolders.length + ' subfolders)\n'
      + '\u2022 Project workspace (' + escapeMrkdwn(m.workspace.provider) + '): ' + linkOrText(r.workspaceUrl, m.workspace.projectName) + ' (' + (Number.isFinite(r.tasksCreated) ? r.tasksCreated : m.workspace.tasks.length) + ' tasks)'),
    { type: 'divider' },
    section('*External invites awaiting approval* (policy: `' + escapeMrkdwn(m.externalInvites.policy) + '`)\n' + invitePlanLines(m.externalInvites)),
    section('*Kickoff agenda draft* (' + (agenda.source === 'llm' ? 'LLM, grounded in intake notes' : 'deterministic template') + ')\n' + markdownToMrkdwn(agenda.agenda))
  ];
  if (agenda.issues && agenda.issues.length) {
    blocks.push(contextBlock(['Agenda checks: ' + agenda.issues.map(escapeMrkdwn).join(', ')]));
  }
  if (p.warnings && p.warnings.length) {
    blocks.push(contextBlock([':warning: ' + p.warnings.map(escapeMrkdwn).join(' | ')]));
  }
  blocks.push({ type: 'divider' });
  blocks.push(section(':lock: *Human approval required.* No external email has been invited and no client communication has been sent. Approvers: ' + approvers));
  blocks.push(approvalActionsBlock({ dealId: m.deal.id, idempotencyKey: m.idempotencyKey, clientChannelId: r.channelId, sandbox: false }));
  blocks.push(contextBlock(['Idempotency key `' + escapeMrkdwn(m.idempotencyKey) + '` \u2022 planner v' + escapeMrkdwn(m.plannerVersion)]));

  return {
    channel: m.approval.channel,
    text: 'Onboarding provisioned for ' + m.company.name + ' - approval required before inviting external contacts.',
    unfurl_links: false,
    unfurl_media: false,
    blocks: capBlocks(blocks)
  };
}

/**
 * Sandbox dry-run preview: shows exactly what WOULD happen, executes nothing.
 */
function buildSandboxPreviewMessage(params) {
  const p = params || {};
  const m = p.manifest;
  if (!m) throw new Error('buildSandboxPreviewMessage requires a manifest.');
  const gate = p.idempotency || {};
  const warnings = p.warnings || [];
  const tree = [escapeMrkdwn(m.drive.rootFolderName) + '/'].concat(m.drive.subfolders.map((f) => '\u2514 ' + escapeMrkdwn(f.name) + '/')).join('\n');
  const tasks = m.workspace.tasks.map((t) => '\u2022 ' + escapeMrkdwn(t.name) + ' \u2014 ' + escapeMrkdwn(t.ownerRole) + ', due ' + t.dueDate).join('\n');

  const blocks = [
    { type: 'header', text: { type: 'plain_text', text: 'SANDBOX DRY RUN \u2014 no external actions executed', emoji: true } },
    section(':test_tube: `SANDBOX_MODE=true`. The plan below was computed from live HubSpot data, but no Slack channel, Drive folder, project, LLM call, invite or CRM write was performed.'),
    fieldsSection(dealFields(m)),
    section('*Idempotency gate:* `' + escapeMrkdwn(gate.decision || 'n/a') + '`\n' + escapeMrkdwn(gate.reason || '') + '\nKey: `' + escapeMrkdwn(m.idempotencyKey) + '`'),
    { type: 'divider' },
    section('*Would create Slack channel:* `#' + escapeMrkdwn(m.slack.channelName) + '` (' + (m.slack.isPrivate ? 'private' : 'public') + ')\nInternal members: ' + (m.slack.internalMemberIds.length ? m.slack.internalMemberIds.map((id) => '<@' + id + '>').join(', ') : '_none configured_')),
    section('*Would create Drive folders* (parent `' + escapeMrkdwn(m.drive.parentFolderId || 'DRIVE_PARENT_FOLDER_ID not set') + '`)\n```' + tree + '```'),
    section('*Would create ' + escapeMrkdwn(m.workspace.provider) + ' project:* ' + escapeMrkdwn(m.workspace.projectName) + '\n' + tasks),
    section('*Kickoff agenda:* ' + (m.kickoff.llmEnabled ? 'would call `' + escapeMrkdwn(m.kickoff.provider) + '` with a grounded prompt (' + m.kickoff.prompt.user.length + ' chars, contact emails excluded).' : 'LLM disabled; deterministic template would be used.')),
    section('*External invites (would require approval):*\n' + invitePlanLines(m.externalInvites))
  ];
  if (warnings.length) blocks.push(contextBlock(['Warnings: ' + warnings.map(escapeMrkdwn).join(' | ')]));
  blocks.push(approvalActionsBlock({ dealId: m.deal.id, idempotencyKey: m.idempotencyKey, clientChannelId: '', sandbox: true }));

  return {
    channel: m.approval.channel,
    text: '[SANDBOX] Onboarding dry run for ' + m.company.name + ' - nothing was provisioned.',
    unfurl_links: false,
    unfurl_media: false,
    blocks: capBlocks(blocks)
  };
}

/**
 * Welcome packet posted into the client channel after approval.
 * Internal links (Drive, CRM) are intentionally excluded.
 */
function buildWelcomeMessage(params) {
  const p = params || {};
  if (!p.channelId) throw new Error('buildWelcomeMessage requires channelId.');
  const company = escapeMrkdwn(p.companyName || 'your team');
  const org = escapeMrkdwn(p.orgName || 'our team');
  const names = (p.invitees || []).map((i) => escapeMrkdwn(i.name)).join(', ');
  const blocks = [
    { type: 'header', text: { type: 'plain_text', text: 'Welcome to your onboarding channel!', emoji: true } },
    section('Hi ' + (names || company) + ' :wave:\nThank you for choosing ' + org + '. This shared channel is the home base for ' + company + '\'s onboarding: questions, updates and decisions all live here.'),
    section('*What happens next*\n\u2022 We\'ll confirm a kickoff time within one business day.\n\u2022 You\'ll receive a short access checklist through a secure channel. Please never share passwords in Slack.\n\u2022 After kickoff you\'ll get a written recap with owners and dates.')
  ];
  if (p.agendaPreview) blocks.push(section('*Draft kickoff agenda*\n' + markdownToMrkdwn(p.agendaPreview)));
  blocks.push(contextBlock(['Sent by ' + org + ' onboarding automation after internal approval.']));
  return { channel: p.channelId, text: 'Welcome to your onboarding channel, ' + (p.companyName || 'team') + '!', unfurl_links: false, blocks: capBlocks(blocks) };
}

const OUTCOME_TITLES = Object.freeze({
  approved: ':white_check_mark: External invites approved and dispatched',
  held: ':double_vertical_bar: Onboarding placed on hold',
  skipped: ':information_source: No action taken (already handled)',
  blocked: ':no_entry: Action blocked by safety checks',
  sandbox_preview: ':test_tube: SANDBOX dry run \u2014 nothing was sent'
});

/**
 * Message sent to the Slack response_url (replaces the approval gate).
 */
function buildApprovalOutcomeMessage(params) {
  const p = params || {};
  const title = OUTCOME_TITLES[p.outcome] || OUTCOME_TITLES.blocked;
  const details = (p.details || []).map((d) => '\u2022 ' + escapeMrkdwn(d)).join('\n');
  const actor = p.actorId ? '<@' + p.actorId + '>' : 'unknown user';
  const blocks = [
    section('*' + title + '*\n' + escapeMrkdwn(p.dealName || '') + (p.companyName ? ' \u2014 ' + escapeMrkdwn(p.companyName) : '')),
    section(details || '_No further details._'),
    contextBlock(['Action by ' + actor + ' \u2022 ' + escapeMrkdwn(p.timestamp || '') + (p.sandbox ? ' \u2022 SANDBOX_MODE=true' : '')])
  ];
  return {
    replace_original: Boolean(p.replaceOriginal),
    response_type: 'in_channel',
    text: title.replace(/:[a-z_]+:\s*/g, ''),
    blocks
  };
}

/**
 * Ephemeral notice for rejected button presses (unauthorized, invalid, ...).
 */
function buildEphemeralRejection(reason) {
  return {
    response_type: 'ephemeral',
    replace_original: false,
    text: 'Action rejected: ' + String(reason || 'not permitted'),
    blocks: [section(':no_entry: *Action rejected.* ' + escapeMrkdwn(reason || 'You are not permitted to perform this action.'))]
  };
}

module.exports = {
  SLACK_ACTION_IDS,
  escapeMrkdwn,
  truncateText,
  markdownToMrkdwn,
  formatMoney,
  buildApprovalButtonValue,
  buildApprovalGateMessage,
  buildSandboxPreviewMessage,
  buildWelcomeMessage,
  buildApprovalOutcomeMessage,
  buildEphemeralRejection
};
