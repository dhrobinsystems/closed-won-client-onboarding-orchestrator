'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  slugifyCompanyName,
  buildSlackChannelName,
  formatDriveFolderName,
  normalizeDomain,
  isValidEmail,
  domainMatches,
  sanitizeMultilineText,
  normalizeDealPayload,
  extractClosedWonDealEvents
} = require('../src/sanitizer');
const { loadSample } = require('./helpers/n8n-harness');

const SLACK_NAME_RULE = /^[a-z0-9][a-z0-9_-]{0,79}$/;

test('sanitizer: Slack channel slug follows client-<slug>-onboarding', () => {
  assert.equal(buildSlackChannelName('Acme Robotics'), 'client-acme-robotics-onboarding');
});

test('sanitizer: legal suffixes and trailing "& Co" are stripped from slugs', () => {
  assert.equal(slugifyCompanyName('Example Business'), 'example-business');
  assert.equal(slugifyCompanyName('Smith & Co'), 'smith');
  assert.equal(slugifyCompanyName('Globex Corporation LLC'), 'globex');
  assert.equal(slugifyCompanyName('Inc'), 'inc');
});

test('sanitizer: ampersands become "and"; diacritics are transliterated', () => {
  assert.equal(slugifyCompanyName('Ben & Jerry Labs'), 'ben-and-jerry-labs');
  assert.equal(slugifyCompanyName('Caf\u00e9 M\u00fcller S\u00e3o Paulo'), 'cafe-muller-sao-paulo');
});

test('sanitizer: unsafe characters, emoji and injection attempts are stripped from channel names', () => {
  const name = buildSlackChannelName('<!channel> @here #General  \ud83d\ude80 Rocket/../Co\u0000rp!!!');
  assert.match(name, SLACK_NAME_RULE);
  assert.ok(!name.includes('--'));
  assert.equal(name, 'client-channel-here-general-rocket-co-rp-onboarding');
});

test('sanitizer: channel names never exceed 80 chars or end slugs with a hyphen', () => {
  const name = buildSlackChannelName('A'.repeat(40) + ' ' + 'B'.repeat(60));
  assert.ok(name.length <= 80);
  assert.match(name, SLACK_NAME_RULE);
  assert.ok(!name.includes('--onboarding'));
  assert.ok(name.endsWith('-onboarding'));
});

test('sanitizer: names with no usable characters fall back to the deal ID, or throw', () => {
  assert.equal(buildSlackChannelName('!!! ???', { fallbackId: '9876543210' }), 'client-deal-9876543210-onboarding');
  assert.throws(() => buildSlackChannelName('***'), /no usable characters/);
});

test('sanitizer: custom channel prefix is itself sanitized', () => {
  assert.equal(buildSlackChannelName('Acme', { prefix: 'Ext Client' }), 'ext-client-acme-onboarding');
});

test('sanitizer: property sweep - every generated channel name satisfies Slack rules', () => {
  const inputs = ['  x  ', 'O\'Reilly Media', 'ACME_CORP', 'a.b.c', '123 Numbers Ltd', '\u4e2d\u6587 Company', 'Tab\tNew\nLine', '-leading-hyphen-', 'UPPER lower MiXeD'];
  for (const input of inputs) {
    const name = buildSlackChannelName(input, { fallbackId: '42' });
    assert.match(name, SLACK_NAME_RULE, input);
    assert.ok(name.length <= 80);
  }
});

test('sanitizer: Drive folder name formats as "YYYY-MM - Company Name" in UTC', () => {
  assert.equal(formatDriveFolderName('Example Business', '2026-11-12T16:30:00.000Z'), '2026-11 - Example Business');
  assert.equal(formatDriveFolderName('Acme', '2026-01-31T23:59:59.000Z'), '2026-01 - Acme');
});

test('sanitizer: Drive folder name accepts HubSpot epoch-millisecond strings', () => {
  assert.equal(formatDriveFolderName('Acme', String(Date.UTC(2027, 2, 15))), '2027-03 - Acme');
});

test('sanitizer: Drive folder name strips path separators and reserved characters', () => {
  const name = formatDriveFolderName('Evil/../Co: "A*B?" <C>|D\\E', '2026-05-01');
  assert.ok(!/[\\/:*?"<>|]/.test(name), name);
  assert.equal(name, '2026-05 - Evil .. Co A B C D E');
});

test('sanitizer: Drive folder name rejects invalid dates and empty names', () => {
  assert.throws(() => formatDriveFolderName('Acme', 'not-a-date'), /invalid date/);
  assert.throws(() => formatDriveFolderName('///', '2026-05-01'), /empty/);
});

test('sanitizer: domains are normalized from URLs, emails and mixed case', () => {
  assert.equal(normalizeDomain('https://www.Example.COM/path?q=1'), 'example.com');
  assert.equal(normalizeDomain('ops@sub.example.org'), 'sub.example.org');
  assert.equal(normalizeDomain('example.net.'), 'example.net');
  assert.equal(normalizeDomain('example.com:8443'), 'example.com');
  assert.equal(normalizeDomain('not a domain'), '');
  assert.equal(normalizeDomain('localhost'), '');
});

test('sanitizer: email validation accepts real-world forms and rejects malformed ones', () => {
  for (const ok of ['a@example.com', 'first.last+tag@sub.example.co', 'UPPER@EXAMPLE.COM']) assert.equal(isValidEmail(ok), true, ok);
  for (const bad of ['not-an-email', 'a@b', '.a@example.com', 'a..b@example.com', 'a@-example.com', '', 'a b@example.com']) assert.equal(isValidEmail(bad), false, bad);
});

test('sanitizer: domainMatches allows subdomains but not look-alike suffixes', () => {
  assert.equal(domainMatches('eu.example.com', 'example.com'), true);
  assert.equal(domainMatches('example.com', 'example.com'), true);
  assert.equal(domainMatches('badexample.com', 'example.com'), false);
});

test('sanitizer: multiline intake notes are stripped of HTML and control characters', () => {
  const text = sanitizeMultilineText('<p>Goal: <b>A&amp;B</b></p><ul><li>One</li><li>Two</li></ul>\u0007<script>x</script>');
  assert.equal(text, 'Goal: A&B\n- One\n- Two\nx');
  assert.match(sanitizeMultilineText('x'.repeat(9000)), /\[truncated\]$/);
});

test('sanitizer: normalizeDealPayload accepts the sample and de-duplicates/filters contacts', () => {
  const sample = loadSample();
  const result = normalizeDealPayload({ deal: sample.deal, company: sample.company, contacts: sample.contacts });
  assert.equal(result.ok, true);
  assert.equal(result.value.company.domain, 'example-business.example.com');
  assert.equal(result.value.deal.amount, 48500);
  assert.equal(result.value.contacts.length, 3);
  assert.equal(result.value.contacts[0].email, 'priya.raman@example-business.example.com');
  assert.equal(result.value.contacts[0].isPrimary, true);
  assert.ok(result.warnings.some((w) => /invalid email/.test(w)));
  assert.ok(!/<p>/.test(result.value.deal.intakeNotes));
});

test('sanitizer: missing company, n8n error objects and bad domains block validation', () => {
  const sample = loadSample();
  assert.equal(normalizeDealPayload({ deal: sample.deal }).ok, false);
  assert.equal(normalizeDealPayload({ deal: sample.deal, company: { error: { message: '404' } } }).ok, false);
  const badDomain = normalizeDealPayload({ deal: sample.deal, company: { id: '1', properties: { name: 'X', domain: 'nope' } } });
  assert.equal(badDomain.ok, false);
  assert.ok(badDomain.errors.some((e) => /domain/.test(e)));
});

test('sanitizer: missing deal name produces a warning and a derived name', () => {
  const result = normalizeDealPayload({
    deal: { id: '1', properties: { dealstage: 'closedwon' } },
    company: { id: '2', properties: { name: 'Acme', domain: 'acme.example.com' } },
    contacts: []
  });
  assert.equal(result.ok, true);
  assert.equal(result.value.deal.name, 'Acme - New Deal');
  assert.ok(result.warnings.some((w) => /No valid client contacts/.test(w)));
});

test('sanitizer: extracts only closed-won dealstage events, latest per deal', () => {
  const sample = loadSample();
  const duplicate = Object.assign({}, sample.webhookEvents[0], { eventId: 1003, occurredAt: sample.webhookEvents[0].occurredAt + 10 });
  const unrelated = Object.assign({}, sample.webhookEvents[0], { propertyName: 'amount', objectId: 1 });
  const events = extractClosedWonDealEvents(sample.webhookEvents.concat([duplicate, unrelated]), 'closedwon');
  assert.equal(events.length, 1);
  assert.equal(events[0].dealId, '9876543210');
  assert.equal(events[0].eventId, '1003');
  assert.equal(events[0].source, 'hubspot_app_webhook');
});

test('sanitizer: extracts workflow-webhook and direct payload shapes', () => {
  assert.equal(extractClosedWonDealEvents({ objectId: 55, properties: { dealstage: { value: 'closedwon' } } }, 'closedwon')[0].dealId, '55');
  assert.equal(extractClosedWonDealEvents({ dealId: '66', dealstage: 'closedwon' }, 'closedwon')[0].source, 'hubspot_workflow_webhook');
  const sample = loadSample();
  assert.equal(extractClosedWonDealEvents({ deal: sample.deal }, 'closedwon')[0].source, 'direct');
  assert.deepEqual(extractClosedWonDealEvents('garbage', 'closedwon'), []);
  assert.throws(() => extractClosedWonDealEvents([], ''), /closedWonStageId/);
});
