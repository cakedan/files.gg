// Signed CDN URLs (worker/utils/signing.js, milestone-3.md §3).
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  MAX_SIGNED_URL_SECONDS,
  albumGrant,
  fileGrant,
  grantForFileRequest,
  signingMessage,
  verifySignedUrl,
} from '../worker/utils/signing.js';
import { SIGNING_SECRET, signature } from './support/signing.js';


const SECRET = 'test-cdn-signing-secret';
// Before every vector's expiry, and less than 31 days before the latest one.
const NOW = 1795600000;

// Contract §3 test vectors, secret `test-cdn-signing-secret`.
const VECTORS = [
  { path: '/files/abc123.png', expires: 1795603600, grant: 'file:1234567890123456789:0', sig: '2S-9Yql24QX8cbVBEPtMDgeEaeiOl7iXlH3fXrkd4q8' },
  { path: '/previews/thumb/abc123.webp', expires: 1795603600, grant: 'file:1234567890123456789:0', sig: 'fMPOSZt5evpHirGRjA7CFTi-t1VKo-Sz_TRY51c0lx0' },
  { path: '/files/abcd/xyz.png', expires: 1795603600, grant: 'file:1234567890123456790:2', sig: 'oBzsm8vQj1Gu63_mqxqJxnryvfOrRIn_lFlRFzE7TJA' },
  { path: '/files/abc123.png', expires: 1795603600, grant: 'album:987654321098765432:3', sig: 'qNXFGzboIRTzeqp-2oNTz9TAXrX9iepHVjSh_W_tR68' },
  { path: '/albums/download/Ab3dE6gH.zip', expires: 1796204800, grant: 'album:987654321098765432:3', sig: 'wGA5TVhWGADqYzNbG7Og11zjDW3n4A9cw5dKtfI4FFA' },
];
// The sixth row: signed with the file grant at access_version 1.
const VERSION_1 = { path: '/files/abc123.png', expires: 1795603600, grant: 'file:1234567890123456789:1', sig: 'Fx-ceAVJ1NUckKl8KkrfXvv9EjlAht92rlHCfcN4RUs' };

const query = (values) => new URLSearchParams(values);
const verify = ({ path, expires, grant, sig }, overrides = {}) => verifySignedUrl({
  secret: SECRET, path, grant, now: NOW, query: query({ expires: String(expires), sig }), ...overrides,
});


describe('contract §3 test vectors', () => {
  VECTORS.forEach((vector, i) => {
    it(`vector ${i + 1}: ${vector.path} with ${vector.grant} verifies`, async () => {
      assert.equal(await verify(vector), true);
    });
  });

  it('the test helper (Node crypto) reproduces every vector byte for byte', () => {
    assert.equal(SIGNING_SECRET, SECRET);
    for (const vector of [...VECTORS, VERSION_1]) {
      assert.equal(signature(vector.path, vector.expires, vector.grant), vector.sig, vector.path);
    }
  });

  it('vector 6: a URL signed at access_version 1 is rejected while the file is at version 0', async () => {
    // The Worker computes the grant from the current lookup: version 0 here.
    assert.equal(await verify({ ...VERSION_1, grant: fileGrant('1234567890123456789', 0) }), false);
    // ...and once the file is at version 1, the version 0 URL (vector 1) is the stale one.
    assert.equal(await verify({ ...VECTORS[0], grant: fileGrant('1234567890123456789', 1) }), false);
    assert.equal(await verify({ ...VERSION_1, grant: fileGrant('1234567890123456789', 1) }), true);
  });

  it('builds the message exactly', () => {
    assert.equal(signingMessage('/files/a.png', '1795603600', 'file:1:0'), 'filesgg-cdn-1\n/files/a.png\n1795603600\nfile:1:0');
  });
});


describe('verifySignedUrl', () => {
  const [first] = VECTORS;

  it('is valid for one path only', async () => {
    for (const path of ['/files/abc123.jpg', '/files/abc124.png', '/previews/thumb/abc123.webp', '/files/abc123.png/', '/files/ABC123.png', '//files/abc123.png']) {
      assert.equal(await verify({ ...first, path }), false, path);
    }
  });

  it('is valid for one grant only: another file, another version, an album grant', async () => {
    for (const grant of ['file:1234567890123456788:0', 'file:1234567890123456789:2', 'album:1234567890123456789:0']) {
      assert.equal(await verify({ ...first, grant }), false, grant);
    }
  });

  it('needs expires > now', async () => {
    assert.equal(await verify(first, { now: first.expires - 1 }), true);
    assert.equal(await verify(first, { now: first.expires }), false);
    assert.equal(await verify(first, { now: first.expires + 1 }), false);
  });

  it('caps expires at now + 31 days', async () => {
    assert.equal(MAX_SIGNED_URL_SECONDS, 31 * 86400);
    assert.equal(await verify(first, { now: first.expires - MAX_SIGNED_URL_SECONDS }), true);
    assert.equal(await verify(first, { now: first.expires - MAX_SIGNED_URL_SECONDS - 1 }), false);
    const far = { path: '/files/a.png', expires: NOW + 32 * 86400, grant: 'file:1:0' };
    assert.equal(await verify({ ...far, sig: signature(far.path, far.expires, far.grant) }), false);
  });

  it('rejects the wrong secret, and fails closed without a secret or a grant', async () => {
    assert.equal(await verify(first, { secret: 'other-secret' }), false);
    for (const secret of ['', undefined, null]) {
      assert.equal(await verify(first, { secret }), false, String(secret));
    }
    for (const grant of ['', undefined, null]) {
      assert.equal(await verify(first, { grant }), false, String(grant));
    }
  });

  it('rejects a missing or malformed expires (it is signed as written, digit for digit)', async () => {
    for (const expires of [undefined, '', '01795603600', '+1795603600', '1795603600.0', '1.7956036e9', ' 1795603600', '-1', '0x6b065f10', '1795603600000000']) {
      const values = { sig: first.sig };
      if (expires !== undefined) {
        values.expires = expires;
      }
      assert.equal(await verifySignedUrl({ secret: SECRET, path: first.path, grant: first.grant, now: NOW, query: query(values) }), false, String(expires));
    }
  });

  it('rejects a missing, padded, re-spelled or truncated signature', async () => {
    const lastBitsFlipped = first.sig.slice(0, -1) + String.fromCharCode(first.sig.charCodeAt(42) + 1);
    for (const sig of [undefined, '', `${first.sig}=`, first.sig.slice(0, -1), `${first.sig}A`, first.sig.replace(/-/g, '+'), lastBitsFlipped, first.sig.toLowerCase()]) {
      const values = { expires: String(first.expires) };
      if (sig !== undefined) {
        values.sig = sig;
      }
      assert.equal(await verifySignedUrl({ secret: SECRET, path: first.path, grant: first.grant, now: NOW, query: query(values) }), false, String(sig));
    }
  });

  it('ignores ?download=true and ?v=, which are not signed', async () => {
    const values = { v: '5', download: 'true', expires: String(first.expires), sig: first.sig };
    assert.equal(await verifySignedUrl({ secret: SECRET, path: first.path, grant: first.grant, now: NOW, query: query(values) }), true);
  });
});


describe('grants', () => {
  it('fileGrant and albumGrant need a decimal id and a non-negative integer version', () => {
    assert.equal(fileGrant('1234567890123456789', 0), 'file:1234567890123456789:0');
    assert.equal(fileGrant(42, 3), 'file:42:3');
    assert.equal(albumGrant('987654321098765432', 3), 'album:987654321098765432:3');
    for (const [id, version] of [[undefined, 0], [null, 0], ['', 0], ['abc', 0], ['1', undefined], ['1', '0'], ['1', -1], ['1', 1.5], ['1:2', 0], [1.5, 0]]) {
      assert.equal(fileGrant(id, version), null, `${id} ${version}`);
      assert.equal(albumGrant(id, version), null, `${id} ${version}`);
    }
  });

  const data = {
    file: { id: '1234567890123456789', vanity: 'abc123' },
    access: { visibility: 'password', access_version: 2 },
    albums: [
      { id: '987654321098765432', vanity: 'Ab3dE6gH', access_version: 3 },
      { id: '987654321098765433', vanity: 'Zz9', access_version: 0 },
    ],
  };

  it('without album=, the file grant from the current lookup', () => {
    assert.equal(grantForFileRequest(data, query({})), 'file:1234567890123456789:2');
    assert.equal(grantForFileRequest({ ...data, file: {} }, query({})), null);
    assert.equal(grantForFileRequest({ ...data, access: {} }, query({})), null);
  });

  it('with album=<vanity>, the grant of that album when the file is shown in it', () => {
    assert.equal(grantForFileRequest(data, query({ album: 'Ab3dE6gH' })), 'album:987654321098765432:3');
    assert.equal(grantForFileRequest(data, query({ album: 'Zz9' })), 'album:987654321098765433:0');
  });

  it('with album=, never the file grant: an unlisted album, a missing list or an empty vanity give nothing', () => {
    for (const album of ['nope', 'ab3de6gh', '', '987654321098765432']) {
      assert.equal(grantForFileRequest(data, query({ album })), null, album);
    }
    for (const albums of [undefined, null, [], 'Ab3dE6gH', [null], [{ id: '1', access_version: 0 }]]) {
      assert.equal(grantForFileRequest({ ...data, albums }, query({ album: 'Ab3dE6gH' })), null, JSON.stringify(albums));
    }
  });

  it('an album URL signed for vector 4 verifies only while the album is at version 3', async () => {
    const vector = VECTORS[3];
    const values = { album: 'Ab3dE6gH', expires: String(vector.expires), sig: vector.sig };
    const at = (version) => verifySignedUrl({
      secret: SECRET, path: vector.path, now: NOW, query: query(values),
      grant: grantForFileRequest({ ...data, albums: [{ ...data.albums[0], access_version: version }] }, query(values)),
    });
    assert.equal(await at(3), true);
    assert.equal(await at(4), false);
  });
});
