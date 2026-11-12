'use strict';

/**
 * src/sanitizer.js
 * Input payload normalizer & validator for HubSpot Deal, Company and Contact
 * objects, plus safe name builders for Slack channels and Drive folders.
 *
 * Accepts both HubSpot CRM v3 API shapes ({ id, properties: {...} }) and
 * flat objects, so the same logic serves live webhooks, tests and samples.
 */

const LEGAL_SUFFIXES = new Set([
  'inc', 'incorporated', 'llc', 'ltd', 'limited', 'corp', 'corporation', 'co',
  'company', 'gmbh', 'plc', 'pty', 'sa', 'sarl', 'bv', 'ag', 'llp', 'lp', 'srl'
]);

const SLACK_CHANNEL_MAX_LENGTH = 80;
const DRIVE_FOLDER_NAME_MAX_LENGTH = 100;
const INTAKE_NOTES_MAX_LENGTH = 8000;
const DEAL_ID_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;
const DOMAIN_PATTERN = /^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z](?:[a-z0-9-]{0,61}[a-z0-9])?$/;
const EMAIL_PATTERN = /^[a-z0-9.!#$%&'*+/=?^_`{|}~-]+@(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z](?:[a-z0-9-]{0,61}[a-z0-9])?$/;

function stripControlChars(value) {
  return String(value === undefined || value === null ? '' : value).replace(/[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u2028\u2029\ufeff]/g, ' ');
}

function sanitizeSingleLineText(value, maxLength) {
  const limit = maxLength || 255;
  return stripControlChars(value).replace(/\s+/g, ' ').trim().slice(0, limit).trim();
}

function decodeBasicEntities(text) {
  return text
    .replace(/&nbsp;/gi, ' ')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/&amp;/gi, '&');
}

/**
 * Normalise multi-line free text (e.g. HubSpot rich-text intake notes):
 * converts block HTML to newlines, strips tags, decodes common entities,
 * removes control characters, collapses blank lines and caps the length.
 */
function sanitizeMultilineText(value, maxLength) {
  const limit = maxLength || INTAKE_NOTES_MAX_LENGTH;
  let text = String(value === undefined || value === null ? '' : value);
  text = text.replace(/\r\n?/g, '\n');
  text = text.replace(/<\s*br\s*\/?>/gi, '\n').replace(/<\/\s*(p|div|li|h[1-6])\s*>/gi, '\n');
  text = text.replace(/<\s*li[^>]*>/gi, '- ');
  text = text.replace(/<[^>]*>/g, '');
  text = decodeBasicEntities(text);
  text = text.replace(/[\u0000-\u0008\u000b-\u001f\u007f-\u009f\u200b-\u200f\u2028\u2029\ufeff]/g, '');
  text = text.split('\n').map((line) => line.replace(/[ \t]+/g, ' ').trim()).join('\n');
  text = text.replace(/\n{3,}/g, '\n\n').trim();
  if (text.length > limit) text = text.slice(0, limit).trim() + '\n[truncated]';
  return text;
}

function normalizeDomain(input) {
  let domain = String(input === undefined || input === null ? '' : input).trim().toLowerCase();
  if (!domain) return '';
  domain = domain.replace(/^[a-z][a-z0-9+.-]*:\/\//, '');
  domain = domain.split(/[/?#]/)[0];
  domain = domain.replace(/^.*@/, '');
  domain = domain.replace(/:\d+$/, '');
  domain = domain.replace(/^www\./, '');
  domain = domain.replace(/\.+$/, '');
  return DOMAIN_PATTERN.test(domain) ? domain : '';
}

function normalizeEmail(email) {
  return String(email === undefined || email === null ? '' : email).trim().toLowerCase();
}

function isValidEmail(email) {
  const value = normalizeEmail(email);
  if (!value || value.length > 254) return false;
  const at = value.lastIndexOf('@');
  if (at < 1) return false;
  const local = value.slice(0, at);
  if (local.length > 64 || local.startsWith('.') || local.endsWith('.') || local.includes('..')) return false;
  return EMAIL_PATTERN.test(value);
}

function emailDomain(email) {
  const value = normalizeEmail(email);
  const at = value.lastIndexOf('@');
  return at === -1 ? '' : value.slice(at + 1);
}

/**
 * True when `domain` equals `parent` or is a subdomain of it.
 */
function domainMatches(domain, parent) {
  const d = normalizeDomain(domain);
  const p = normalizeDomain(parent);
  if (!d || !p) return false;
  return d === p || d.endsWith('.' + p);
}

function slugifyCompanyName(name, options) {
  const opts = options || {};
  const maxLength = opts.maxLength || 50;
  const base = stripControlChars(name)
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/&/g, ' and ')
    .replace(/['\u2019`]/g, '');
  const tokens = base.split(/[^a-z0-9]+/).filter(Boolean);
  if (opts.stripLegalSuffixes !== false) {
    while (tokens.length > 1 && LEGAL_SUFFIXES.has(tokens[tokens.length - 1])) tokens.pop();
    while (tokens.length > 1 && tokens[tokens.length - 1] === 'and') tokens.pop();
  }
  let slug = tokens.join('-');
  if (slug.length > maxLength) slug = slug.slice(0, maxLength).replace(/-+$/, '');
  return slug;
}

/**
 * Build a Slack-safe channel name: `<prefix>-<slug>-onboarding`.
 * Slack rules: lowercase, max 80 chars, letters/digits/hyphens/underscores.
 */
function buildSlackChannelName(companyName, options) {
  const opts = options || {};
  const prefix = slugifyCompanyName(opts.prefix || 'client', { stripLegalSuffixes: false, maxLength: 20 }) || 'client';
  const suffix = 'onboarding';
  const maxSlugLength = SLACK_CHANNEL_MAX_LENGTH - prefix.length - suffix.length - 2;
  let slug = slugifyCompanyName(companyName, { maxLength: maxSlugLength });
  if (!slug) {
    const fallbackId = String(opts.fallbackId || '').toLowerCase().replace(/[^a-z0-9]/g, '').slice(0, 20);
    if (!fallbackId) {
      throw new Error('Cannot build Slack channel name: company name has no usable characters and no fallback ID was provided.');
    }
    slug = 'deal-' + fallbackId;
  }
  return prefix + '-' + slug + '-' + suffix;
}

/**
 * Parse HubSpot dates: ISO strings, epoch-millisecond numbers/strings, Date.
 */
function parseHubSpotDate(value) {
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? null : new Date(value.getTime());
  if (value === undefined || value === null || value === '') return null;
  const raw = String(value).trim();
  const date = /^\d{10,14}$/.test(raw) ? new Date(Number(raw)) : new Date(raw);
  return Number.isNaN(date.getTime()) ? null : date;
}

function formatYearMonth(date) {
  return date.getUTCFullYear() + '-' + String(date.getUTCMonth() + 1).padStart(2, '0');
}

function formatIsoDate(date) {
  return formatYearMonth(date) + '-' + String(date.getUTCDate()).padStart(2, '0');
}

/**
 * Build the Drive root folder name: `YYYY-MM - <Company Name>` (UTC month).
 */
function formatDriveFolderName(companyName, dateInput) {
  const date = parseHubSpotDate(dateInput);
  if (!date) throw new Error('Cannot format Drive folder name: invalid date "' + dateInput + '".');
  const cleanName = stripControlChars(companyName)
    .replace(/[\\/:*?"<>|]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/^\.+/, '')
    .trim();
  if (!cleanName) throw new Error('Cannot format Drive folder name: company name is empty after sanitization.');
  const prefix = formatYearMonth(date) + ' - ';
  return (prefix + cleanName).slice(0, DRIVE_FOLDER_NAME_MAX_LENGTH).trim();
}

function readProperty(record, name) {
  if (!record || typeof record !== 'object') return undefined;
  const props = record.properties;
  if (props && Object.prototype.hasOwnProperty.call(props, name)) {
    const value = props[name];
    if (value && typeof value === 'object' && 'value' in value) return value.value;
    return value;
  }
  if (Object.prototype.hasOwnProperty.call(record, name)) return record[name];
  return undefined;
}

function parseAmount(value) {
  if (value === undefined || value === null || value === '') return null;
  const n = Number(String(value).replace(/[,\s]/g, ''));
  return Number.isFinite(n) ? n : null;
}

function normalizeContact(raw) {
  const email = normalizeEmail(readProperty(raw, 'email'));
  return {
    id: String(raw && (raw.id || readProperty(raw, 'hs_object_id')) || ''),
    email,
    firstName: sanitizeSingleLineText(readProperty(raw, 'firstname') || readProperty(raw, 'firstName'), 80),
    lastName: sanitizeSingleLineText(readProperty(raw, 'lastname') || readProperty(raw, 'lastName'), 80),
    jobTitle: sanitizeSingleLineText(readProperty(raw, 'jobtitle') || readProperty(raw, 'jobTitle'), 120),
    isPrimary: Boolean(raw && (raw.isPrimary === true || readProperty(raw, 'is_primary_contact') === 'true'))
  };
}

function contactsArray(input) {
  if (!input) return [];
  if (Array.isArray(input)) return input;
  if (Array.isArray(input.results)) return input.results;
  return [];
}

/**
 * Normalise and validate a HubSpot deal + company + contacts bundle.
 * @returns {{ok:boolean, errors:string[], warnings:string[], value:object|null}}
 */
function normalizeDealPayload(input, options) {
  const opts = options || {};
  const intakeProp = opts.intakeNotesProperty || 'deal_intake_notes';
  const errors = [];
  const warnings = [];
  const payload = input || {};
  const rawDeal = payload.deal;
  const rawCompany = payload.company;

  if (!rawDeal || typeof rawDeal !== 'object') {
    return { ok: false, errors: ['Missing deal object.'], warnings, value: null };
  }

  const dealId = String(rawDeal.id || readProperty(rawDeal, 'hs_object_id') || rawDeal.dealId || '').trim();
  if (!DEAL_ID_PATTERN.test(dealId)) errors.push('Deal ID is missing or malformed.');

  const stageId = sanitizeSingleLineText(readProperty(rawDeal, 'dealstage'), 64);
  if (!stageId) errors.push('Deal stage (dealstage) is missing.');

  const closeDate = parseHubSpotDate(readProperty(rawDeal, 'closedate'));
  if (!closeDate) warnings.push('Deal close date missing or invalid; provisioning date will be used for folder naming.');

  let company = null;
  if (!rawCompany || typeof rawCompany !== 'object' || rawCompany.status === 'error' || rawCompany.error) {
    errors.push('Associated company is missing (a deal must be associated with exactly one primary company).');
  } else {
    const companyName = sanitizeSingleLineText(readProperty(rawCompany, 'name'), 120);
    const rawDomain = readProperty(rawCompany, 'domain') || readProperty(rawCompany, 'website');
    const domain = normalizeDomain(rawDomain);
    if (!companyName) errors.push('Company name is missing.');
    if (!domain) errors.push('Company domain is missing or invalid ("' + sanitizeSingleLineText(rawDomain, 80) + '").');
    company = {
      id: String(rawCompany.id || readProperty(rawCompany, 'hs_object_id') || ''),
      name: companyName,
      domain
    };
  }

  let dealName = sanitizeSingleLineText(readProperty(rawDeal, 'dealname'), 150);
  if (!dealName) {
    dealName = company && company.name ? company.name + ' - New Deal' : 'Untitled Deal';
    warnings.push('Deal name missing; using "' + dealName + '".');
  }

  const seenEmails = new Set();
  const contacts = [];
  for (const raw of contactsArray(payload.contacts)) {
    const contact = normalizeContact(raw);
    if (!contact.email) {
      warnings.push('Contact ' + (contact.id || '(unknown id)') + ' has no email and was skipped.');
      continue;
    }
    if (!isValidEmail(contact.email)) {
      warnings.push('Contact ' + (contact.id || '(unknown id)') + ' has an invalid email and was skipped.');
      continue;
    }
    if (seenEmails.has(contact.email)) continue;
    seenEmails.add(contact.email);
    contacts.push(contact);
  }
  if (contacts.length === 0) warnings.push('No valid client contacts found; no external invites will be proposed.');
  if (contacts.length > 0 && !contacts.some((c) => c.isPrimary)) contacts[0].isPrimary = true;

  const value = {
    deal: {
      id: dealId,
      name: dealName,
      stageId,
      pipelineId: sanitizeSingleLineText(readProperty(rawDeal, 'pipeline'), 64),
      amount: parseAmount(readProperty(rawDeal, 'amount')),
      currency: (sanitizeSingleLineText(readProperty(rawDeal, 'deal_currency_code'), 3) || 'USD').toUpperCase(),
      closeDate: closeDate ? closeDate.toISOString() : null,
      ownerId: sanitizeSingleLineText(readProperty(rawDeal, 'hubspot_owner_id'), 32),
      intakeNotes: sanitizeMultilineText(readProperty(rawDeal, intakeProp)),
      onboardingStatus: sanitizeSingleLineText(readProperty(rawDeal, 'onboarding_status'), 40).toLowerCase(),
      storedIdempotencyKey: sanitizeSingleLineText(readProperty(rawDeal, 'onboarding_idempotency_key'), 64),
      storedSlackChannelId: sanitizeSingleLineText(readProperty(rawDeal, 'onboarding_slack_channel_id'), 32)
    },
    company,
    contacts
  };

  return { ok: errors.length === 0, errors, warnings, value: errors.length === 0 ? value : null };
}

/**
 * Extract closed-won deal events from an inbound webhook body.
 * Supports: HubSpot app webhook batches (array of deal.propertyChange events),
 * HubSpot workflow webhooks ({ objectId, properties }), flat
 * { dealId, dealstage } bodies and direct { deal, company, contacts } bundles.
 * Returns one event per deal (latest occurrence wins), sorted by dealId.
 */
function extractClosedWonDealEvents(body, closedWonStageId) {
  if (!closedWonStageId) throw new Error('closedWonStageId is required.');
  let events;
  if (Array.isArray(body)) events = body;
  else if (body && Array.isArray(body.events)) events = body.events;
  else if (body && typeof body === 'object') events = [body];
  else events = [];

  const byDeal = new Map();
  for (const event of events) {
    if (!event || typeof event !== 'object') continue;
    let dealId;
    let stageId;
    let source;
    if (event.deal && typeof event.deal === 'object') {
      dealId = event.deal.id || readProperty(event.deal, 'hs_object_id');
      stageId = readProperty(event.deal, 'dealstage');
      source = 'direct';
    } else if (event.subscriptionType) {
      if (!/^deal\.propertyChange$/i.test(event.subscriptionType) || event.propertyName !== 'dealstage') continue;
      dealId = event.objectId;
      stageId = event.propertyValue;
      source = 'hubspot_app_webhook';
    } else {
      dealId = event.objectId !== undefined ? event.objectId : (event.dealId !== undefined ? event.dealId : event.hs_object_id);
      stageId = event.propertyValue !== undefined ? event.propertyValue : readProperty(event, 'dealstage');
      source = 'hubspot_workflow_webhook';
    }
    const id = String(dealId === undefined || dealId === null ? '' : dealId).trim();
    if (!DEAL_ID_PATTERN.test(id)) continue;
    if (String(stageId || '').trim() !== closedWonStageId) continue;
    const occurredAt = Number(event.occurredAt) || 0;
    const existing = byDeal.get(id);
    if (!existing || occurredAt >= existing.occurredAt) {
      byDeal.set(id, {
        dealId: id,
        stageId: closedWonStageId,
        occurredAt,
        eventId: event.eventId !== undefined ? String(event.eventId) : '',
        source
      });
    }
  }
  return Array.from(byDeal.values()).sort((a, b) => a.dealId.localeCompare(b.dealId));
}

module.exports = {
  stripControlChars,
  sanitizeSingleLineText,
  sanitizeMultilineText,
  normalizeDomain,
  normalizeEmail,
  isValidEmail,
  emailDomain,
  domainMatches,
  slugifyCompanyName,
  buildSlackChannelName,
  parseHubSpotDate,
  formatYearMonth,
  formatIsoDate,
  formatDriveFolderName,
  readProperty,
  normalizeDealPayload,
  extractClosedWonDealEvents
};
