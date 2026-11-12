'use strict';

/**
 * src/security.js
 * Request-authenticity helpers: Slack request signatures (v0), HubSpot
 * webhook signatures (v3), constant-time comparison and response_url guards.
 *
 * Zero dependencies: callers inject the HMAC primitive, so this module runs
 * unchanged in n8n Code nodes (their glue code loads Node's crypto module)
 * and in tests.
 */

function constantTimeEqual(a, b) {
  const left = String(a === undefined || a === null ? '' : a);
  const right = String(b === undefined || b === null ? '' : b);
  let diff = left.length ^ right.length;
  const length = Math.max(left.length, right.length);
  for (let i = 0; i < length; i += 1) {
    diff |= (left.charCodeAt(i) || 0) ^ (right.charCodeAt(i) || 0);
  }
  return diff === 0;
}

function getHeader(headers, name) {
  if (!headers || typeof headers !== 'object') return '';
  const target = String(name).toLowerCase();
  for (const key of Object.keys(headers)) {
    if (key.toLowerCase() === target) {
      const value = headers[key];
      return Array.isArray(value) ? String(value[0] || '') : String(value === undefined || value === null ? '' : value);
    }
  }
  return '';
}

function verificationFailure(reason) {
  return { valid: false, reason };
}

/**
 * Verify a Slack request signature (https://api.slack.com/authentication/verifying-requests-from-slack).
 * @param {object} params
 * @param {string} params.signingSecret
 * @param {string} params.timestamp X-Slack-Request-Timestamp (seconds)
 * @param {string} params.rawBody exact raw request body
 * @param {string} params.signature X-Slack-Signature ("v0=<hex>")
 * @param {number} params.nowSeconds current unix time in seconds
 * @param {number} [params.toleranceSeconds=300]
 * @param {(secret:string, message:string)=>string} params.hmacSha256Hex
 */
function verifySlackSignature(params) {
  const p = params || {};
  const tolerance = Number.isFinite(p.toleranceSeconds) ? p.toleranceSeconds : 300;
  if (!p.signingSecret) return verificationFailure('missing_signing_secret');
  if (typeof p.hmacSha256Hex !== 'function') return verificationFailure('missing_hmac_implementation');
  const timestamp = String(p.timestamp || '');
  if (!/^\d{1,12}$/.test(timestamp)) return verificationFailure('invalid_timestamp');
  if (!Number.isFinite(p.nowSeconds)) return verificationFailure('missing_clock');
  if (Math.abs(p.nowSeconds - Number(timestamp)) > tolerance) return verificationFailure('stale_timestamp');
  const signature = String(p.signature || '');
  if (!/^v0=[a-f0-9]{64}$/.test(signature)) return verificationFailure('malformed_signature');
  if (typeof p.rawBody !== 'string') return verificationFailure('missing_raw_body');
  const expected = 'v0=' + p.hmacSha256Hex(p.signingSecret, 'v0:' + timestamp + ':' + p.rawBody);
  return constantTimeEqual(expected, signature) ? { valid: true, reason: 'ok' } : verificationFailure('signature_mismatch');
}

/**
 * Verify a HubSpot v3 webhook signature
 * (base64 HMAC-SHA256 of method + uri + body + timestamp, keyed by the app client secret).
 */
function verifyHubSpotSignatureV3(params) {
  const p = params || {};
  const maxAgeMs = Number.isFinite(p.maxAgeMs) ? p.maxAgeMs : 5 * 60 * 1000;
  if (!p.clientSecret) return verificationFailure('missing_client_secret');
  if (typeof p.hmacSha256Base64 !== 'function') return verificationFailure('missing_hmac_implementation');
  const timestamp = String(p.timestamp || '');
  if (!/^\d{10,14}$/.test(timestamp)) return verificationFailure('invalid_timestamp');
  if (!Number.isFinite(p.nowMs)) return verificationFailure('missing_clock');
  if (Math.abs(p.nowMs - Number(timestamp)) > maxAgeMs) return verificationFailure('stale_timestamp');
  if (!p.signature) return verificationFailure('missing_signature');
  if (!p.uri || !p.method) return verificationFailure('missing_request_target');
  if (typeof p.rawBody !== 'string') return verificationFailure('missing_raw_body');
  const source = String(p.method).toUpperCase() + p.uri + p.rawBody + timestamp;
  const expected = p.hmacSha256Base64(p.clientSecret, source);
  return constantTimeEqual(expected, p.signature) ? { valid: true, reason: 'ok' } : verificationFailure('signature_mismatch');
}

/**
 * SSRF guard: only Slack's own response_url hosts may be called back.
 */
function isTrustedSlackResponseUrl(url) {
  return /^https:\/\/hooks\.slack\.com\/(actions|commands|app)\/[A-Za-z0-9/_-]+$/.test(String(url || ''));
}

module.exports = {
  constantTimeEqual,
  getHeader,
  verifySlackSignature,
  verifyHubSpotSignatureV3,
  isTrustedSlackResponseUrl
};
