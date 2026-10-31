'use strict';

/**
 * Time-based one-time codes (RFC 6238, the authenticator apps' 6 digits every 30 seconds, HMAC-SHA1)
 * for two-factor sign-in (docs/plan-10.1.md, Phase 12), and recovery codes. Node's crypto only.
 */

const crypto = require('crypto');

const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
const STEP_SECONDS = 30;
const DIGITS = 6;

/** Bytes → base32 (no padding), as authenticator apps take secrets. */
function base32Encode(buffer) {
  let bits = 0;
  let value = 0;
  let out = '';
  for (const byte of buffer) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += ALPHABET[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += ALPHABET[(value << (5 - bits)) & 31];
  return out;
}

/** Base32 (any case, spaces and padding ignored) → bytes. */
function base32Decode(text) {
  const clean = String(text || '')
    .toUpperCase()
    .replace(/[\s=-]/g, '');
  let bits = 0;
  let value = 0;
  const out = [];
  for (const ch of clean) {
    const index = ALPHABET.indexOf(ch);
    if (index < 0) throw new Error('Not a base32 secret');
    value = (value << 5) | index;
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 255);
      bits -= 8;
    }
  }
  return Buffer.from(out);
}

/** A new secret: 20 random bytes, base32. */
const newSecret = () => base32Encode(crypto.randomBytes(20));

/** The time step of a moment (30-second windows since 1970). */
const stepOf = (ms = Date.now()) => Math.floor(ms / 1000 / STEP_SECONDS);

/** The code for a secret at a time step. */
function codeAt(secret, step) {
  const counter = Buffer.alloc(8);
  counter.writeBigUInt64BE(BigInt(step));
  const hmac = crypto.createHmac('sha1', base32Decode(secret)).update(counter).digest();
  const offset = hmac[hmac.length - 1] & 15;
  const number = ((hmac[offset] & 127) << 24) | (hmac[offset + 1] << 16) | (hmac[offset + 2] << 8) | hmac[offset + 3];
  return String(number % 10 ** DIGITS).padStart(DIGITS, '0');
}

/**
 * The time step a code matches (this one, or one before or after for clocks a little off), or
 * null. `after`: steps up to and including it are refused (a code used once cannot be used again).
 */
function verify(secret, code, { now = Date.now(), after = null } = {}) {
  const typed = String(code || '').replace(/\s/g, '');
  if (!/^\d{6}$/.test(typed)) return null;
  const current = stepOf(now);
  for (const step of [current, current - 1, current + 1]) {
    if (after !== null && step <= after) continue;
    const expected = codeAt(secret, step);
    if (crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(typed))) return step;
  }
  return null;
}

/** The address an authenticator app's QR code holds. */
function otpauthUrl(secret, account, issuer = 'JusttPrint') {
  const label = encodeURIComponent(`${issuer}:${account}`);
  return `otpauth://totp/${label}?secret=${secret}&issuer=${encodeURIComponent(issuer)}&algorithm=SHA1&digits=${DIGITS}&period=${STEP_SECONDS}`;
}

// ---- Recovery codes: ten, shown once, kept as hashes; each works once ----

const hashCode = (code) =>
  crypto
    .createHash('sha256')
    .update(
      String(code || '')
        .toLowerCase()
        .replace(/[^a-z0-9]/g, '')
    )
    .digest('hex');

/** Ten new recovery codes ("abcd-efgh-ijkl") and their hashes. */
function newRecoveryCodes(count = 10) {
  const codes = Array.from({ length: count }, () =>
    crypto
      .randomBytes(9)
      .toString('base64url')
      .toLowerCase()
      .replace(/[^a-z0-9]/g, 'x')
      .slice(0, 12)
      .replace(/(.{4})(.{4})(.{4})/, '$1-$2-$3')
  );
  return { codes, hashes: codes.map(hashCode) };
}

/** Use a recovery code: the hashes left when it matches one, else null. */
function useRecoveryCode(hashes, code) {
  const hash = hashCode(code);
  const list = Array.isArray(hashes) ? hashes : [];
  const index = list.findIndex((h) => h.length === hash.length && crypto.timingSafeEqual(Buffer.from(h), Buffer.from(hash)));
  if (index < 0) return null;
  return list.filter((_, i) => i !== index);
}

module.exports = { base32Encode, base32Decode, newSecret, stepOf, codeAt, verify, otpauthUrl, newRecoveryCodes, useRecoveryCode, STEP_SECONDS };
