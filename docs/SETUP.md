# Setup & Deployment Guide

Work through these steps in order. Keep `SANDBOX_MODE=true` until step 9.

## 0. Prerequisites

* n8n **1.x or newer** (self-hosted or cloud) with the Code node and Webhook node v2.
* Node.js **20 or 22** (only for running tests and builds locally).
* Admin access to HubSpot, a Slack workspace (paid plan for Slack Connect invites), Google Drive, and ClickUp, Asana or Notion.
* Optional: an OpenAI or Anthropic API key.

## 1. Configure the n8n host

Add these to the n8n process environment (for example in docker-compose):

```yaml
environment:
  - N8N_BLOCK_ENV_ACCESS_IN_NODE=false   # Code nodes read config from env
  - NODE_FUNCTION_ALLOW_BUILTIN=crypto   # signature verification
  - SANDBOX_MODE=true
  # ...all other variables from .env.example
```

Restart n8n afterwards. If env access stays blocked, the workflows fall back to defaults and stay in sandbox. `Load Config` reports a warning when this happens.

## 2. HubSpot

1. **Create the custom deal properties** (Settings → Properties → Deal). Single-line text is fine for all of them:

   | Internal name | Purpose |
   | --- | --- |
   | `onboarding_status` | `provisioning` / `awaiting_approval` / `on_hold` / `client_invited` / `failed` |
   | `onboarding_idempotency_key` | Deterministic key written before provisioning |
   | `onboarding_slack_channel_id` | Client channel ID |
   | `onboarding_drive_folder_url` | Drive root folder link |
   | `onboarding_workspace_url` | Project URL or ID |
   | `deal_intake_notes` | Sales intake notes (multi-line text). Rename via `HUBSPOT_INTAKE_NOTES_PROPERTY`. |

2. **Create a private app** (Settings → Integrations → Private Apps) with read/write access to deals, read access to companies and contacts, and permission to create notes. Scope names change over time, so pick them in HubSpot's scope picker. Copy the access token.
3. **Find your Closed Won stage ID** (Settings → Objects → Deals → Pipelines → ⋯ → stage ID). The default pipeline uses `closedwon`. Set `HUBSPOT_CLOSED_WON_STAGE_ID`.
4. Set up the trigger after importing workflow 01 (step 7). Choose one:
   * **App webhook (recommended):** in a HubSpot developer app, subscribe to `deal.propertyChange` → `dealstage`, with target URL = the production webhook URL of workflow 01. Set `HUBSPOT_APP_CLIENT_SECRET` and `HUBSPOT_WEBHOOK_TARGET_URL` to enable v3 signature checks.
   * **HubSpot workflow:** Deal-based workflow, trigger "Deal stage is Closed Won", action **Send a webhook** (POST) to the same URL. The workflow accepts `{ objectId }` or `{ dealId, dealstage }` bodies.

## 3. Slack app

1. Create an app at <https://api.slack.com/apps>.
2. Add these **bot token scopes**: `chat:write`, `channels:manage`, `groups:write`, `conversations.connect:write` (Slack Connect invites). Add `channels:read` and `groups:read` if you want n8n channel pickers.
3. Install the app to the workspace and copy the **Bot User OAuth Token**.
4. Under **Basic Information → App Credentials**, copy the **Signing Secret** into `SLACK_SIGNING_SECRET`.
5. Invite the bot to your hand-off channel (`/invite @YourBot` in `#cs-handoffs`).
6. Under **Interactivity & Shortcuts**, enable Interactivity. Set the Request URL to workflow 02's production webhook URL (step 7).
7. Collect the user IDs (Profile → ⋯ → Copy member ID) for `SLACK_INTERNAL_MEMBER_IDS` and `APPROVER_SLACK_USER_IDS`.

## 4. Google Drive

1. Create (or choose) a parent folder, such as `Clients/Onboarding`, and copy its ID from the URL into `DRIVE_PARENT_FOLDER_ID`.
2. In n8n, create a **Google Drive OAuth2 API** credential. The connected account needs edit access to the parent folder. Shared drives are supported.

## 5. Project workspace

Set `WORKSPACE_PROVIDER` and `WORKSPACE_CONTAINER_ID`:

| Provider | Container ID | n8n **Header Auth** credential |
| --- | --- | --- |
| `clickup` | Space ID (a List is created per client) | Name `Authorization`, Value `pk_…` personal token |
| `asana` | Team GID (a Project is created per client) | Name `Authorization`, Value `Bearer <PAT>` |
| `notion` | Parent page ID (a page with to-dos is created) | Name `Authorization`, Value `Bearer <integration secret>`. Share the parent page with the integration. |

The `Notion-Version` header is added automatically.

## 6. LLM (optional)

Set `LLM_PROVIDER=openai` or `anthropic` and set `LLM_MODEL`. Then create a **Header Auth** credential:

* OpenAI: Name `Authorization`, Value `Bearer <key>`
* Anthropic: Name `x-api-key`, Value `<key>` (`anthropic-version` is sent automatically)

With `LLM_PROVIDER=none`, a deterministic agenda template is used.

## 7. Import the workflows

1. In n8n, go to **Workflows → Import from File** and choose `workflows/01-closed-won-provisioning-orchestrator.json`, then `02-client-invite-approval-dispatcher.json`.
2. Open each node marked with a credential warning and select your credential. Every credential ships as `REPLACE_WITH_YOUR_CREDENTIAL_ID`:
   * HubSpot nodes → **HubSpot App Token** credential (private app token)
   * Slack nodes → **Slack API** credential (bot token)
   * Google Drive nodes → **Google Drive OAuth2 API**
   * `Workspace: *` → workspace Header Auth credential
   * `LLM: Draft Kickoff Agenda` → LLM Header Auth credential
3. Copy each workflow's **Production URL** from its webhook node into HubSpot (step 2.4) and Slack Interactivity (step 3.6).
4. **Activate** both workflows. They ship inactive.

## 8. Sandbox rehearsal

1. Move a test deal (with an associated company that has a domain, plus contacts) to Closed Won.
2. A `SANDBOX DRY RUN` message should appear in the approval channel. It shows the channel name, Drive tree, tasks, invite plan and idempotency decision.
3. Click **(Sandbox) Approve External Invites**. A sandbox outcome notice lists who *would* be invited. Nothing is sent.
4. Check the n8n executions: nothing should have been created, and no HubSpot property should have changed.

You can also rehearse offline with `npm run simulate`.

## 9. Go live

1. Fill in every live-mode variable: `DRIVE_PARENT_FOLDER_ID`, `WORKSPACE_CONTAINER_ID`, `SLACK_INTERNAL_MEMBER_IDS`, `APPROVER_SLACK_USER_IDS`.
2. Set `SANDBOX_MODE=false` and restart n8n. `Load Config` refuses to run if any live requirement is missing.
3. Test with one internal test deal whose contacts use **your own** domain (add it via `EXTERNAL_INVITE_DOMAIN_POLICY=allowlist` temporarily).
4. Confirm that the channel, folders, project and approval gate were created, and that the HubSpot properties show `awaiting_approval`. Then click **Approve External Invites** and confirm the invite, the welcome packet, the HubSpot note and the `client_invited` status.

## 10. Operations

* **Error workflow:** set an n8n Error Workflow on workflow 01 that alerts `#cs-handoffs` and sets `onboarding_status=failed`.
* **Retry after failure:** review partial resources, then clear `onboarding_status` and `onboarding_idempotency_key` on the deal and move it back to Closed Won.
* **Upgrades:** after editing `src/`, run `npm test && npm run build && npm run check`, then re-import the JSON. Credentials are kept when you import over a workflow with the same node names.
* **Rate limits:** Drive, workspace and Slack invite nodes are batched (one request per 0.4 s / 1.5 s). Raise the intervals if your plans are stricter.
