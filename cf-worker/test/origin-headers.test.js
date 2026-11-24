import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  CLIENT_IP_HEADER,
  ORIGIN_SECRET_HEADER,
  originRequestHeaders,
} from '../worker/utils/security.js';


const incoming = () => new Headers({
  'authorization': 'token',
  'cf-connecting-ip': '203.0.113.5',
  'x-filesgg-client-ip': '6.6.6.6',
  'X-Filesgg-Origin-Secret': 'guessed',
});


describe('originRequestHeaders', () => {
  it('strips client-supplied copies and sets both headers from the binding and CF-Connecting-IP', () => {
    const { headers, trusted } = originRequestHeaders(incoming(), 's3cret');
    assert.equal(trusted, true);
    assert.equal(headers.get(ORIGIN_SECRET_HEADER), 's3cret');
    assert.equal(headers.get(CLIENT_IP_HEADER), '203.0.113.5');
    assert.equal(headers.get('authorization'), 'token');
  });

  it('uses an explicit client IP over the copied headers', () => {
    const { headers } = originRequestHeaders(incoming(), 's3cret', '2001:db8::1');
    assert.equal(headers.get(CLIENT_IP_HEADER), '2001:db8::1');
  });

  it('fails closed without the secret binding: neither header is sent', () => {
    for (const secret of [undefined, null, '', 42]) {
      const { headers, trusted } = originRequestHeaders(incoming(), secret);
      assert.equal(trusted, false);
      assert.equal(headers.has(ORIGIN_SECRET_HEADER), false);
      assert.equal(headers.has(CLIENT_IP_HEADER), false);
      assert.equal(headers.get('authorization'), 'token');
    }
  });

  it('never forwards a client IP the client chose when CF-Connecting-IP is missing', () => {
    const spoofed = new Headers({ 'x-filesgg-client-ip': '6.6.6.6' });
    const { headers } = originRequestHeaders(spoofed, 's3cret');
    assert.equal(headers.has(CLIENT_IP_HEADER), false);
    assert.equal(headers.get(ORIGIN_SECRET_HEADER), 's3cret');
  });

  it('does not modify the incoming headers and accepts a plain object', () => {
    const original = incoming();
    originRequestHeaders(original, 's3cret');
    assert.equal(original.get('x-filesgg-client-ip'), '6.6.6.6');
    assert.equal(original.get('x-filesgg-origin-secret'), 'guessed');

    const { headers } = originRequestHeaders({ 'CF-Connecting-IP': ' 198.51.100.4 ' }, 's3cret');
    assert.equal(headers.get(CLIENT_IP_HEADER), '198.51.100.4');
  });
});
