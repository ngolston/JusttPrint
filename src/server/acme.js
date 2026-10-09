'use strict';

/**
 * A small ACME client (RFC 8555) for Let's Encrypt: account, order, HTTP-01 challenge, finalize,
 * download. Signs with Node's crypto; the certificate request is built with @peculiar/x509.
 * Replaces acme-client, whose node-forge dependency has an advisory with no fixed release.
 */

const crypto = require('crypto');
const x509 = require('@peculiar/x509');

// Node's webcrypto types differ slightly from the DOM ones @peculiar/x509 is typed against.
x509.cryptoProvider.set(/** @type {any} */ (crypto.webcrypto));

const DIRECTORY = {
  production: 'https://acme-v02.api.letsencrypt.org/directory',
  staging: 'https://acme-staging-v02.api.letsencrypt.org/directory'
};

const POLL_ATTEMPTS = 60;
const POLL_DEFAULT_MS = 2000;

const b64url = (data) => Buffer.from(data).toString('base64url');
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** A new RSA 2048 private key, PEM (PKCS#8). */
function createPrivateKey() {
  const { privateKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
  return privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();
}

/** The JWS algorithm and public JWK (members in the order the RFC 7638 thumbprint needs). */
function accountJwk(privateKey) {
  const jwk = crypto.createPublicKey(privateKey).export({ format: 'jwk' });
  if (jwk.kty === 'RSA') return { alg: 'RS256', jwk: { e: jwk.e, kty: 'RSA', n: jwk.n } };
  if (jwk.kty === 'EC' && jwk.crv === 'P-256') return { alg: 'ES256', jwk: { crv: jwk.crv, kty: 'EC', x: jwk.x, y: jwk.y } };
  throw new Error('The ACME account key must be RSA or EC P-256.');
}

/** A PEM certificate request for `domain`, and its new private key. */
async function createCsr(domain) {
  const algorithm = { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256', publicExponent: new Uint8Array([1, 0, 1]), modulusLength: 2048 };
  const keys = await crypto.webcrypto.subtle.generateKey(algorithm, true, ['sign', 'verify']);
  const csr = await x509.Pkcs10CertificateRequestGenerator.create({
    name: `CN=${domain}`,
    keys: /** @type {any} */ (keys),
    signingAlgorithm: algorithm,
    extensions: [new x509.SubjectAlternativeNameExtension([{ type: 'dns', value: domain }])]
  });
  const pkcs8 = await crypto.webcrypto.subtle.exportKey('pkcs8', keys.privateKey);
  const keyPem = crypto
    .createPrivateKey({ key: Buffer.from(pkcs8), format: 'der', type: 'pkcs8' })
    .export({ type: 'pkcs8', format: 'pem' })
    .toString();
  return { csrDer: Buffer.from(csr.rawData), keyPem };
}

class AcmeClient {
  /** @param {{ directoryUrl: string, accountKey: string | Buffer }} options */
  constructor({ directoryUrl, accountKey }) {
    this.directoryUrl = directoryUrl;
    this.key = crypto.createPrivateKey(accountKey);
    const { alg, jwk } = accountJwk(this.key);
    this.alg = alg;
    this.jwk = jwk;
    this.thumbprint = crypto.createHash('sha256').update(JSON.stringify(jwk)).digest('base64url');
    /** @type {any} */
    this.directory = null;
    /** @type {string | null} */
    this.nonce = null;
    /** @type {string | null} */
    this.kid = null;
  }

  async getDirectory() {
    if (!this.directory) {
      const res = await fetch(this.directoryUrl);
      if (!res.ok) throw new Error(`ACME directory ${this.directoryUrl} answered HTTP ${res.status}`);
      this.directory = await res.json();
    }
    return this.directory;
  }

  async getNonce() {
    if (this.nonce) {
      const nonce = this.nonce;
      this.nonce = null;
      return nonce;
    }
    const res = await fetch((await this.getDirectory()).newNonce, { method: 'HEAD' });
    const nonce = res.headers.get('replay-nonce');
    if (!nonce) throw new Error('The ACME server sent no nonce.');
    return nonce;
  }

  sign(data) {
    return this.alg === 'ES256' ? crypto.sign('sha256', data, { key: this.key, dsaEncoding: 'ieee-p1363' }) : crypto.sign('sha256', data, this.key);
  }

  /**
   * A signed POST; `payload` undefined is a POST-as-GET. Retries once on a rejected nonce.
   * @returns {Promise<{ res: Response, body: any }>}
   */
  async post(url, payload, { accept = 'application/json', retry = true } = {}) {
    /** @type {Record<string, unknown>} */
    const header = { alg: this.alg, nonce: await this.getNonce(), url };
    if (this.kid) header.kid = this.kid;
    else header.jwk = this.jwk;
    const protectedB64 = b64url(JSON.stringify(header));
    const payloadB64 = payload === undefined ? '' : b64url(JSON.stringify(payload));
    const signature = this.sign(Buffer.from(`${protectedB64}.${payloadB64}`)).toString('base64url');
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/jose+json', Accept: accept },
      body: JSON.stringify({ protected: protectedB64, payload: payloadB64, signature })
    });
    this.nonce = res.headers.get('replay-nonce') || null;
    const type = res.headers.get('content-type') || '';
    const body = type.includes('json') ? await res.json() : await res.text();
    if (!res.ok) {
      if (retry && body && body.type === 'urn:ietf:params:acme:error:badNonce') return this.post(url, payload, { accept, retry: false });
      const detail = body && typeof body === 'object' ? `${body.detail || body.type || ''}` : String(body).slice(0, 200);
      throw new Error(`ACME request failed (HTTP ${res.status}): ${detail}`);
    }
    return { res, body };
  }

  async createAccount(email) {
    const { res } = await this.post((await this.getDirectory()).newAccount, {
      termsOfServiceAgreed: true,
      contact: [`mailto:${email}`]
    });
    this.kid = res.headers.get('location');
    if (!this.kid) throw new Error('The ACME server did not return an account URL.');
  }

  /** POST-as-GET `url` until its status leaves `pending`/`processing`. */
  async poll(url, what) {
    for (let attempt = 0; attempt < POLL_ATTEMPTS; attempt++) {
      const { res, body } = await this.post(url);
      if (body.status !== 'pending' && body.status !== 'processing') return body;
      const retryAfter = Number(res.headers.get('retry-after'));
      await sleep(Number.isFinite(retryAfter) && retryAfter > 0 ? Math.min(retryAfter, 10) * 1000 : POLL_DEFAULT_MS);
    }
    throw new Error(`Timed out waiting for the ACME ${what}.`);
  }

  /**
   * Orders a certificate for `domain`, answering HTTP-01 through the callbacks.
   * @param {{ domain: string, onChallenge: (token: string, keyAuthorization: string) => void, onChallengeDone: (token: string) => void }} options
   * @returns {Promise<{ certPem: string, keyPem: string }>}
   */
  async orderCertificate({ domain, onChallenge, onChallengeDone }) {
    const directory = await this.getDirectory();
    const { res: orderRes, body: order } = await this.post(directory.newOrder, { identifiers: [{ type: 'dns', value: domain }] });
    const orderUrl = orderRes.headers.get('location');
    if (!orderUrl) throw new Error('The ACME server did not return an order URL.');

    for (const authzUrl of order.authorizations) {
      const { body: authz } = await this.post(authzUrl);
      if (authz.status === 'valid') continue;
      const challenge = (authz.challenges || []).find((c) => c.type === 'http-01');
      if (!challenge) throw new Error(`The ACME server offered no http-01 challenge for ${domain}.`);
      onChallenge(challenge.token, `${challenge.token}.${this.thumbprint}`);
      try {
        await this.post(challenge.url, {});
        const result = await this.poll(authzUrl, 'authorization');
        if (result.status !== 'valid') {
          const failed = (result.challenges || []).find((c) => c.type === 'http-01');
          const reason = failed && failed.error ? failed.error.detail || failed.error.type : result.status;
          throw new Error(`${domain} could not be verified: ${reason}`);
        }
      } finally {
        onChallengeDone(challenge.token);
      }
    }

    const { csrDer, keyPem } = await createCsr(domain);
    await this.post(order.finalize, { csr: b64url(csrDer) });
    const finished = await this.poll(orderUrl, 'order');
    if (finished.status !== 'valid' || !finished.certificate) {
      const reason = finished.error ? finished.error.detail || finished.error.type : finished.status;
      throw new Error(`The certificate order did not complete: ${reason}`);
    }
    const { body: certPem } = await this.post(finished.certificate, undefined, { accept: 'application/pem-certificate-chain' });
    return { certPem: String(certPem), keyPem };
  }
}

module.exports = { AcmeClient, DIRECTORY, createPrivateKey, createCsr };
