#!/usr/bin/env node
'use strict';

// The ACME client (src/server/acme.js) against a stand-in ACME server that checks every JWS.
// Checked by hand against Pebble, Let's Encrypt's test server, with real HTTP-01 validation.

const assert = require('assert');
const crypto = require('crypto');
const http = require('http');
const x509 = require('@peculiar/x509');
const { AcmeClient, createPrivateKey, createCsr } = require('../src/server/acme');

const tests = [];
const test = (name, fn) => tests.push([name, fn]);

test('the account thumbprint is RFC 7638 (required members, sorted, no spaces)', () => {
  const rsaKey = createPrivateKey();
  const rsa = crypto.createPublicKey(rsaKey).export({ format: 'jwk' });
  const expectedRsa = `{"e":"${rsa.e}","kty":"RSA","n":"${rsa.n}"}`;
  assert.strictEqual(
    new AcmeClient({ directoryUrl: 'http://unused', accountKey: rsaKey }).thumbprint,
    crypto.createHash('sha256').update(expectedRsa).digest('base64url')
  );

  const ecKey = crypto.generateKeyPairSync('ec', { namedCurve: 'P-256' }).privateKey;
  const ec = crypto.createPublicKey(ecKey).export({ format: 'jwk' });
  const expectedEc = `{"crv":"P-256","kty":"EC","x":"${ec.x}","y":"${ec.y}"}`;
  assert.strictEqual(
    new AcmeClient({ directoryUrl: 'http://unused', accountKey: ecKey.export({ type: 'pkcs8', format: 'pem' }) }).thumbprint,
    crypto.createHash('sha256').update(expectedEc).digest('base64url')
  );
});

test('the certificate request names the domain and is signed by its key', async () => {
  const { csrDer, keyPem } = await createCsr('prints.example.com');
  const csr = new x509.Pkcs10CertificateRequest(csrDer);
  assert.strictEqual(csr.subject, 'CN=prints.example.com');
  const san = csr.extensions.find((ext) => ext instanceof x509.SubjectAlternativeNameExtension);
  assert.deepStrictEqual(
    san.names.items.map((name) => name.value),
    ['prints.example.com']
  );
  assert.ok(await csr.verify());
  const publicFromKey = crypto.createPublicKey(keyPem).export({ type: 'spki', format: 'der' });
  assert.ok(Buffer.from(csr.publicKey.rawData).equals(publicFromKey));
});

/** A stand-in ACME server: verifies each JWS and nonce, rejects one good nonce, issues a fake chain. */
function startFakeAcme() {
  const nonces = new Set();
  const seen = { accounts: 0, challengeKeyAuth: null, rejectedNonce: false, csr: null };
  let base = '';
  let accountJwk = null;
  let polls = 0;
  const newNonce = () => {
    const nonce = crypto.randomBytes(8).toString('base64url');
    nonces.add(nonce);
    return nonce;
  };
  const send = (res, status, body, headers = {}) => {
    res.writeHead(status, { 'Replay-Nonce': newNonce(), ...headers });
    res.end(typeof body === 'string' ? body : JSON.stringify(body));
  };
  const json = { 'Content-Type': 'application/json' };
  const server = http.createServer((req, res) => {
    if (req.url === '/dir') {
      return send(res, 200, { newNonce: `${base}/nonce`, newAccount: `${base}/account`, newOrder: `${base}/order` }, json);
    }
    if (req.url === '/nonce') return send(res, 200, '');
    let raw = '';
    req.on('data', (chunk) => (raw += chunk));
    req.on('end', () => {
      const jws = JSON.parse(raw);
      const header = JSON.parse(Buffer.from(jws.protected, 'base64url').toString());
      const payload = jws.payload ? JSON.parse(Buffer.from(jws.payload, 'base64url').toString()) : undefined;
      assert.strictEqual(header.url, `${base}${req.url}`, 'url in the protected header');
      assert.ok(nonces.delete(header.nonce), 'nonce was issued and not reused');
      if (!seen.rejectedNonce) {
        seen.rejectedNonce = true;
        return send(res, 400, { type: 'urn:ietf:params:acme:error:badNonce' }, { 'Content-Type': 'application/problem+json' });
      }
      if (req.url === '/account') {
        accountJwk = header.jwk;
        assert.ok(!header.kid, 'newAccount signs with the jwk');
        assert.deepStrictEqual(payload.contact, ['mailto:me@example.com']);
        assert.strictEqual(payload.termsOfServiceAgreed, true);
        seen.accounts++;
      } else {
        assert.strictEqual(header.kid, `${base}/acct/1`, 'later requests sign with the account URL');
      }
      const key = crypto.createPublicKey({ key: accountJwk, format: 'jwk' });
      const data = Buffer.from(`${jws.protected}.${jws.payload}`);
      const sig = Buffer.from(jws.signature, 'base64url');
      const ok = header.alg === 'ES256' ? crypto.verify('sha256', data, { key, dsaEncoding: 'ieee-p1363' }, sig) : crypto.verify('sha256', data, key, sig);
      assert.ok(ok, `signature on ${req.url}`);

      switch (req.url) {
        case '/account':
          return send(res, 201, { status: 'valid' }, { ...json, Location: `${base}/acct/1` });
        case '/order':
          assert.deepStrictEqual(payload.identifiers, [{ type: 'dns', value: 'prints.example.com' }]);
          return send(
            res,
            201,
            { status: 'pending', authorizations: [`${base}/authz/1`], finalize: `${base}/finalize/1` },
            { ...json, Location: `${base}/orders/1` }
          );
        case '/authz/1':
          return send(
            res,
            200,
            {
              status: seen.challengeKeyAuth ? 'valid' : 'pending',
              challenges: [
                { type: 'dns-01', url: `${base}/chall/dns`, token: 'dns-token' },
                { type: 'http-01', url: `${base}/chall/1`, token: 'tok123' }
              ]
            },
            json
          );
        case '/chall/1':
          seen.challengeKeyAuth = seen.pendingKeyAuth;
          return send(res, 200, { status: 'processing' }, json);
        case '/finalize/1':
          seen.csr = Buffer.from(payload.csr, 'base64url');
          return send(res, 200, { status: 'processing' }, json);
        case '/orders/1':
          polls++;
          return send(res, 200, polls < 2 ? { status: 'processing' } : { status: 'valid', certificate: `${base}/cert/1` }, { ...json, 'Retry-After': '0' });
        case '/cert/1':
          assert.strictEqual(req.headers.accept, 'application/pem-certificate-chain');
          return send(res, 200, '-----BEGIN CERTIFICATE-----\nfake\n-----END CERTIFICATE-----\n', { 'Content-Type': 'application/pem-certificate-chain' });
        default:
          return send(res, 404, { type: 'urn:ietf:params:acme:error:malformed' }, json);
      }
    });
  });
  return new Promise((resolve) =>
    server.listen(0, '127.0.0.1', () => {
      base = `http://127.0.0.1:${server.address().port}`;
      resolve({ server, seen, directoryUrl: `${base}/dir` });
    })
  );
}

for (const [label, makeKey] of [
  ['RSA', () => createPrivateKey()],
  ['EC P-256', () => crypto.generateKeyPairSync('ec', { namedCurve: 'P-256' }).privateKey.export({ type: 'sec1', format: 'pem' })]
]) {
  test(`orders a certificate with an ${label} account key`, async () => {
    const { server, seen, directoryUrl } = await startFakeAcme();
    try {
      const client = new AcmeClient({ directoryUrl, accountKey: makeKey() });
      await client.createAccount('me@example.com');
      const served = new Map();
      const { certPem, keyPem } = await client.orderCertificate({
        domain: 'prints.example.com',
        onChallenge: (token, keyAuthorization) => {
          served.set(token, keyAuthorization);
          seen.pendingKeyAuth = keyAuthorization;
        },
        onChallengeDone: (token) => served.delete(token)
      });
      assert.strictEqual(seen.challengeKeyAuth, `tok123.${client.thumbprint}`);
      assert.strictEqual(served.size, 0, 'the challenge is cleared afterwards');
      assert.ok(seen.rejectedNonce, 'a rejected nonce was retried');
      assert.match(certPem, /BEGIN CERTIFICATE/);
      const csr = new x509.Pkcs10CertificateRequest(seen.csr);
      assert.strictEqual(csr.subject, 'CN=prints.example.com');
      assert.ok(Buffer.from(csr.publicKey.rawData).equals(crypto.createPublicKey(keyPem).export({ type: 'spki', format: 'der' })));
    } finally {
      server.close();
    }
  });
}

(async () => {
  for (const [name, fn] of tests) {
    try {
      await fn();
      console.log(`ok ${name}`);
    } catch (err) {
      console.error(`FAIL ${name}:`, err.message);
      process.exitCode = 1;
    }
  }
})();
