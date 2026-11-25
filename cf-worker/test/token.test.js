import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  base64urlDecode,
  base64urlEncode,
  canonicalJson,
  signToken,
  tokenGrantsAccess,
  verifyToken,
} from '../worker/utils/token.js';


// docs/redesign/contracts/milestone-2.md §1, secret `test-cdn-token-secret`.
const SECRET = 'test-cdn-token-secret';
const VECTORS = [
  {
    claims: { e: 1795603600, k: 'file', s: 'unlock', t: '1234567890123456789', u: 1795600000, v: 0 },
    token: 'eyJlIjoxNzk1NjAzNjAwLCJrIjoiZmlsZSIsInMiOiJ1bmxvY2siLCJ0IjoiMTIzNDU2Nzg5MDEyMzQ1Njc4OSIsInUiOjE3OTU2MDAwMDAsInYiOjB9.PsqqCMSrEKpmQoEe1y5Sof1fZadAnlzQdnW7ygtxuLk',
  },
  {
    claims: { e: 1796204800, k: 'album', s: 'unlock', t: '987654321098765432', u: 1795600000, v: 3 },
    token: 'eyJlIjoxNzk2MjA0ODAwLCJrIjoiYWxidW0iLCJzIjoidW5sb2NrIiwidCI6Ijk4NzY1NDMyMTA5ODc2NTQzMiIsInUiOjE3OTU2MDAwMDAsInYiOjN9.363h20AIfnXPJ20FngplD6_ARO_pidniwnoIaD0Lebk',
  },
  {
    claims: { e: 1795603600, k: 'file', s: 'owner', t: '1234567890123456789', u: 1795600000, v: 2 },
    token: 'eyJlIjoxNzk1NjAzNjAwLCJrIjoiZmlsZSIsInMiOiJvd25lciIsInQiOiIxMjM0NTY3ODkwMTIzNDU2Nzg5IiwidSI6MTc5NTYwMDAwMCwidiI6Mn0.S7b7xKQg5Cu19qkZa4BGRNLeZgwmnVmqGjN_1p4nFiE',
  },
];
const TAMPERED = 'eyJlIjoxNzk1NjAzNjAwLCJrIjoiZmlsZSIsInMiOiJ1bmxvY2siLCJ0IjoiMTIzNDU2Nzg5MDEyMzQ1Njc4OSIsInUiOjE3OTU2MDAwMDAsInYiOjF9.PsqqCMSrEKpmQoEe1y5Sof1fZadAnlzQdnW7ygtxuLk';
const BEFORE_EXPIRY = 1795600001;


describe('contract §1 test vectors', () => {
  VECTORS.forEach(({ claims, token }, i) => {
    it(`vector ${i + 1}: signs byte-identically`, async () => {
      assert.equal(await signToken(claims, SECRET), token);
    });

    it(`vector ${i + 1}: verifies to the same claims`, async () => {
      assert.deepEqual(await verifyToken(token, SECRET, BEFORE_EXPIRY), claims);
    });
  });

  it('vector 4: the tampered token (v changed to 1, old signature) is rejected', async () => {
    assert.equal(await verifyToken(TAMPERED, SECRET, BEFORE_EXPIRY), null);
  });

  it('serialises claims with sorted keys whatever the insertion order', async () => {
    const shuffled = { v: 0, u: 1795600000, t: '1234567890123456789', s: 'unlock', k: 'file', e: 1795603600 };
    assert.equal(canonicalJson(shuffled), JSON.stringify(VECTORS[0].claims));
    assert.equal(await signToken(shuffled, SECRET), VECTORS[0].token);
  });
});


describe('verifyToken', () => {
  const [first] = VECTORS;

  it('rejects an expired token (e must be strictly after now)', async () => {
    assert.equal(await verifyToken(first.token, SECRET, first.claims.e), null);
    assert.equal(await verifyToken(first.token, SECRET, first.claims.e + 1), null);
    assert.notEqual(await verifyToken(first.token, SECRET, first.claims.e - 1), null);
  });

  it('rejects the wrong secret, and fails closed without one', async () => {
    assert.equal(await verifyToken(first.token, 'other-secret', BEFORE_EXPIRY), null);
    assert.equal(await verifyToken(first.token, '', BEFORE_EXPIRY), null);
    assert.equal(await verifyToken(first.token, undefined, BEFORE_EXPIRY), null);
  });

  it('rejects malformed tokens', async () => {
    const [body, signature] = first.token.split('.');
    for (const token of [
      undefined, null, '', '.', body, `${body}.`, `.${signature}`, `${body}.${signature}.x`,
      `${body}=.${signature}`, `${body}.${signature}=`, `${body}.${signature.slice(0, -1)}`,
      `${body}+.${signature}`, `${body}.${signature}`.padEnd(2000, 'A'),
    ]) {
      assert.equal(await verifyToken(token, SECRET, BEFORE_EXPIRY), null, String(token).slice(0, 40));
    }
  });

  it('rejects a correctly signed token with bad claims', async () => {
    const good = VECTORS[0].claims;
    for (const claims of [
      { ...good, t: 1234567890123456789 },
      { ...good, k: 'user' },
      { ...good, s: 'admin' },
      { ...good, v: '0' },
      { ...good, v: -1 },
      { ...good, e: '1795603600' },
      { ...good, extra: 1 },
      (({ u, ...rest }) => rest)(good),
    ]) {
      assert.equal(await verifyToken(await signToken(claims, SECRET), SECRET, BEFORE_EXPIRY), null, JSON.stringify(claims));
    }
  });

  it('round-trips base64url without padding', () => {
    for (const length of [1, 2, 3, 4, 31, 32]) {
      const bytes = Uint8Array.from({ length }, (_, i) => (i * 37 + 250) % 256);
      const encoded = base64urlEncode(bytes);
      assert.doesNotMatch(encoded, /[=+/]/);
      assert.deepEqual(base64urlDecode(encoded), bytes);
    }
  });
});


describe('tokenGrantsAccess (contract §1 rules 3 and 4, §2 albums)', () => {
  const file = (overrides) => ({ k: 'file', t: '111', s: 'unlock', v: 2, u: 1, e: 2, ...overrides });
  const album = (overrides) => ({ k: 'album', t: '900', s: 'unlock', v: 5, u: 1, e: 2, ...overrides });
  const albums = [{ id: '900', access_version: 5 }, { id: '901', access_version: 0 }];
  const target = (overrides) => ({ fileId: '111', accessVersion: 2, albums, visibility: 'password', ...overrides });

  it('a file token opens only its own file at the current access_version', () => {
    assert.equal(tokenGrantsAccess(file(), target()), true);
    assert.equal(tokenGrantsAccess(file(), target({ fileId: '112' })), false);
    assert.equal(tokenGrantsAccess(file({ v: 1 }), target()), false);
    assert.equal(tokenGrantsAccess(file(), target({ fileId: 111 })), true);
  });

  it('an album token passes with a matching id and access_version', () => {
    assert.equal(tokenGrantsAccess(album(), target()), true);
    assert.equal(tokenGrantsAccess(album({ t: '901', v: 0 }), target()), true);
  });

  it('an album token fails with a stale version', () => {
    assert.equal(tokenGrantsAccess(album({ v: 4 }), target()), false);
    assert.equal(tokenGrantsAccess(album({ t: '901', v: 5 }), target()), false);
    assert.equal(tokenGrantsAccess(album(), target({ albums: [{ id: '900', access_version: '5' }] })), false);
  });

  it('an album token fails for an unlisted id, or when albums is missing or empty', () => {
    assert.equal(tokenGrantsAccess(album({ t: '902' }), target()), false);
    for (const value of [[], undefined, null, '900', [null], ['900']]) {
      assert.equal(tokenGrantsAccess(album(), target({ albums: value })), false, JSON.stringify(value));
    }
  });

  it('an album token never opens a private file, except as an owner pass', () => {
    assert.equal(tokenGrantsAccess(album(), target({ visibility: 'private' })), false);
    assert.equal(tokenGrantsAccess(album({ s: 'owner' }), target({ visibility: 'private' })), true);
  });

  it('a missing file id denies every token (fail closed)', () => {
    for (const fileId of [undefined, null, '']) {
      assert.equal(tokenGrantsAccess(file(), target({ fileId })), false, String(fileId));
      assert.equal(tokenGrantsAccess(album(), target({ fileId })), false, String(fileId));
    }
    assert.equal(tokenGrantsAccess(null, target()), false);
  });
});
