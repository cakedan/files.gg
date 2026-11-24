import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  CDN_CONTENT_SECURITY_POLICY,
  MAX_FILENAME_BYTES,
  cdnSecurityHeaders,
  contentDisposition,
  corsHeaders,
  isCredentialedRoute,
  isInlineAllowed,
  isValidProxyToken,
  parseAllowedOrigins,
  sanitizeFilename,
} from '../worker/utils/security.js';


const utf8Bytes = (value) => Buffer.byteLength(value, 'utf8');


describe('sanitizeFilename', () => {
  it('strips the RTL override from invoice‮fdp.exe', () => {
    const result = sanitizeFilename('invoice‮fdp.exe');
    assert.equal(result, 'invoicefdp.exe');
    assert.ok(result.endsWith('.exe'));
  });

  it('strips every bidi control', () => {
    const bidi = '‪‫‬‭‮⁦⁧⁨⁩‎‏؜';
    assert.equal(sanitizeFilename(`a${bidi}b.txt`), 'ab.txt');
  });

  it('strips zero-width characters', () => {
    assert.equal(sanitizeFilename('pho​to‌‍⁠﻿.png'), 'photo.png');
  });

  it('strips C0 and C1 control characters', () => {
    assert.equal(sanitizeFilename('a\u0000b\u0007c\u001B\u007F\u0085\u009Fd.txt'), 'abcd.txt');
  });

  it('turns tabs and newlines into single spaces and collapses whitespace', () => {
    assert.equal(sanitizeFilename('my \t\r\n  file 　name.txt'), 'my file name.txt');
  });

  it('trims leading and trailing dots and spaces', () => {
    assert.equal(sanitizeFilename('  ..hidden.txt.. '), 'hidden.txt');
  });

  it('caps a long name at 255 UTF-8 bytes and keeps the extension', () => {
    const result = sanitizeFilename('a'.repeat(400) + '.tar.gz');
    assert.equal(utf8Bytes(result), MAX_FILENAME_BYTES);
    assert.ok(result.endsWith('.gz'));
    assert.match(result, /^a+\.gz$/);
  });

  it('caps multi-byte names without splitting characters', () => {
    const result = sanitizeFilename('\u{1F600}'.repeat(100) + '.png');
    assert.ok(utf8Bytes(result) <= MAX_FILENAME_BYTES);
    assert.ok(result.endsWith('.png'));
    assert.equal(result, '\u{1F600}'.repeat(62) + '.png');
  });

  it('falls back to "file" when nothing is left', () => {
    assert.equal(sanitizeFilename(''), 'file');
    assert.equal(sanitizeFilename('   '), 'file');
    assert.equal(sanitizeFilename('...'), 'file');
    assert.equal(sanitizeFilename('‮​\u0000'), 'file');
    assert.equal(sanitizeFilename(null), 'file');
    assert.equal(sanitizeFilename(undefined), 'file');
  });

  it('keeps a double extension like photo.jpg.zip in full', () => {
    assert.equal(sanitizeFilename('photo.jpg.zip'), 'photo.jpg.zip');
  });

  it('keeps the real (last) extension of a long double-extension name', () => {
    const result = sanitizeFilename('x'.repeat(300) + '.jpg.zip');
    assert.ok(result.endsWith('.zip'));
    assert.ok(utf8Bytes(result) <= MAX_FILENAME_BYTES);
  });

  it('leaves normal unicode names alone', () => {
    assert.equal(sanitizeFilename('résumé 履歴書.pdf'), 'résumé 履歴書.pdf');
  });
});


describe('contentDisposition', () => {
  it('uses the RFC 6266 form with an ASCII fallback and filename*', () => {
    assert.equal(
      contentDisposition('attachment', 'photo.png'),
      'attachment; filename="photo.png"; filename*=UTF-8\'\'photo.png',
    );
    assert.equal(
      contentDisposition('inline', 'my photo.png'),
      'inline; filename="my photo.png"; filename*=UTF-8\'\'my%20photo.png',
    );
  });

  it('escapes quotes and backslashes in the fallback', () => {
    const value = contentDisposition('attachment', 'a"b\\c.txt');
    assert.ok(value.includes('filename="a\\"b\\\\c.txt"'));
    assert.ok(value.includes("filename*=UTF-8''a%22b%5Cc.txt"));
  });

  it('replaces non-ASCII in the fallback and percent-encodes it in filename*', () => {
    const value = contentDisposition('attachment', 'résumé \u{1F600}.pdf');
    assert.ok(value.includes('filename="r_sum_ _.pdf"'));
    assert.ok(value.includes("filename*=UTF-8''r%C3%A9sum%C3%A9%20%F0%9F%98%80.pdf"));
    assert.ok(/^[\x20-\x7E]*$/.test(value));
  });

  it('percent-encodes characters outside RFC 5987 attr-char', () => {
    const value = contentDisposition('attachment', "it's (1)*.txt");
    assert.ok(value.endsWith("filename*=UTF-8''it%27s%20%281%29%2A.txt"));
  });

  it('cannot be used for CRLF header injection', () => {
    const value = contentDisposition('attachment', 'evil.txt\r\nSet-Cookie: a=b\r\n\r\n<html>');
    assert.ok(!/[\r\n]/.test(value));
    assert.ok(/^[\x20-\x7E]*$/.test(value));
    assert.ok(value.includes('filename="evil.txt__Set-Cookie: a=b____<html>"'));
    assert.ok(value.includes('%0D%0A'));
    // and through sanitizeFilename, as cdn.js does it:
    assert.equal(
      contentDisposition('attachment', sanitizeFilename('evil.txt\r\nSet-Cookie: a=b')),
      'attachment; filename="evil.txt Set-Cookie: a=b"; filename*=UTF-8\'\'evil.txt%20Set-Cookie%3A%20a%3Db',
    );
  });

  it('only emits inline or attachment', () => {
    assert.ok(contentDisposition('inline\r\nX: y', 'a.txt').startsWith('attachment;'));
    assert.ok(contentDisposition(undefined, 'a.txt').startsWith('attachment;'));
  });

  it('survives lone surrogates', () => {
    assert.doesNotThrow(() => contentDisposition('attachment', 'a\uD800b.txt'));
    assert.equal(sanitizeFilename('a\uD800b.txt'), 'a�b.txt');
  });
});


describe('isInlineAllowed', () => {
  const cases = [
    ['image/svg+xml', false],
    ['application/pdf', false],
    ['text/html', false], // forced to text/plain before this is asked
    ['application/xhtml+xml', false],
    ['video/mp4', true],
    ['image/png', true],
    ['image/gif', true],
    ['audio/mpeg', true],
    ['text/plain', true],
    ['text/plain; charset=utf-8', true],
    ['TEXT/PLAIN', true],
    ['text/css', false],
    ['text/javascript', false],
    ['application/octet-stream', false],
    ['application/zip', false],
    ['application/xml', false],
    ['', false],
    [undefined, false],
    ['image', false],
  ];
  for (const [mimetype, expected] of cases) {
    it(`${JSON.stringify(mimetype)} -> ${expected}`, () => {
      assert.equal(isInlineAllowed(mimetype), expected);
    });
  }
});


describe('cdnSecurityHeaders', () => {
  it('returns exactly the specified headers', () => {
    assert.deepEqual(cdnSecurityHeaders(), {
      'Content-Security-Policy': "sandbox; default-src 'none'; img-src 'self' data:; media-src 'self'; style-src 'unsafe-inline'; frame-ancestors https://files.gg",
      'X-Content-Type-Options': 'nosniff',
      'Cross-Origin-Opener-Policy': 'same-origin',
      'Referrer-Policy': 'no-referrer',
      'Cross-Origin-Resource-Policy': 'cross-origin',
    });
    assert.equal(CDN_CONTENT_SECURITY_POLICY, cdnSecurityHeaders()['Content-Security-Policy']);
  });

  it('returns a fresh object each call', () => {
    const a = cdnSecurityHeaders();
    a['X-Content-Type-Options'] = 'tampered';
    assert.equal(cdnSecurityHeaders()['X-Content-Type-Options'], 'nosniff');
  });
});


describe('corsHeaders', () => {
  const allowedOrigins = ['https://files.gg'];
  const allowHeaders = 'Authorization, Content-Type, X-Fingerprint';

  it('reflects an allowlisted origin on a credentialed route', () => {
    const headers = corsHeaders({ origin: 'https://files.gg', allowedOrigins, credentialed: true });
    assert.equal(headers['Access-Control-Allow-Origin'], 'https://files.gg');
    assert.equal(headers['Access-Control-Allow-Credentials'], 'true');
    assert.equal(headers['Vary'], 'Origin');
    assert.equal(headers['Access-Control-Allow-Headers'], allowHeaders);
  });

  it('gives a foreign origin on a credentialed route `*` without credentials', () => {
    const headers = corsHeaders({ origin: 'https://evil.example', allowedOrigins, credentialed: true });
    assert.equal(headers['Access-Control-Allow-Origin'], '*');
    assert.ok(!('Access-Control-Allow-Credentials' in headers));
    assert.equal(headers['Vary'], 'Origin');
    assert.equal(headers['Access-Control-Allow-Headers'], allowHeaders);
  });

  it('never credentials a lookalike or null origin', () => {
    for (const origin of ['https://files.gg.evil.example', 'http://files.gg', 'https://cdn.files.gg', 'null', '']) {
      const headers = corsHeaders({ origin, allowedOrigins, credentialed: true });
      assert.equal(headers['Access-Control-Allow-Origin'], '*', origin);
      assert.ok(!('Access-Control-Allow-Credentials' in headers), origin);
    }
  });

  it('gives an allowlisted origin on a non-credentialed route `*` without credentials', () => {
    const headers = corsHeaders({ origin: 'https://files.gg', allowedOrigins, credentialed: false });
    assert.deepEqual(headers, {
      'Access-Control-Allow-Headers': allowHeaders,
      'Access-Control-Allow-Methods': 'DELETE, GET, HEAD, OPTIONS, PATCH, POST, PUT',
      'Access-Control-Allow-Origin': '*',
    });
  });

  it('gives a foreign origin on a non-credentialed route `*`', () => {
    const headers = corsHeaders({ origin: 'https://evil.example', allowedOrigins });
    assert.equal(headers['Access-Control-Allow-Origin'], '*');
    assert.ok(!('Access-Control-Allow-Credentials' in headers));
    assert.ok(!('Vary' in headers));
  });

  it('defaults the allowlist to https://files.gg', () => {
    const headers = corsHeaders({ origin: 'https://files.gg', credentialed: true });
    assert.equal(headers['Access-Control-Allow-Credentials'], 'true');
  });

  it('parses the allowlist from config', () => {
    assert.deepEqual(parseAllowedOrigins(undefined), ['https://files.gg']);
    assert.deepEqual(parseAllowedOrigins(''), ['https://files.gg']);
    assert.deepEqual(parseAllowedOrigins('*'), ['https://files.gg']);
    assert.deepEqual(
      parseAllowedOrigins(' https://files.gg/ , https://Beta.files.gg,null '),
      ['https://files.gg', 'https://beta.files.gg'],
    );
  });

  it('treats the API passthrough as credentialed and everything else as not', () => {
    assert.equal(isCredentialedRoute('api.files.gg', '/files/abc'), true);
    assert.equal(isCredentialedRoute('files.gg', '/api/files/abc'), true);
    assert.equal(isCredentialedRoute('www.files.gg', '/api'), true);
    assert.equal(isCredentialedRoute('files.gg', '/apixyz'), false);
    assert.equal(isCredentialedRoute('files.gg', '/abcd/xyz.png'), false);
    assert.equal(isCredentialedRoute('cdn.files.gg', '/api/files/abc'), false);
    assert.equal(isCredentialedRoute('proxy.files.gg', '/download/x'), false);
  });
});


describe('isValidProxyToken', () => {
  it('fails closed without a configured secret', () => {
    assert.equal(isValidProxyToken('lol', undefined), false);
    assert.equal(isValidProxyToken('', ''), false);
    assert.equal(isValidProxyToken(null, undefined), false);
  });

  it('accepts only the exact secret', () => {
    assert.equal(isValidProxyToken('s3cret', 's3cret'), true);
    assert.equal(isValidProxyToken('s3cre', 's3cret'), false);
    assert.equal(isValidProxyToken('s3cretx', 's3cret'), false);
    assert.equal(isValidProxyToken('S3cret', 's3cret'), false);
    assert.equal(isValidProxyToken(null, 's3cret'), false);
    assert.equal(isValidProxyToken('', 's3cret'), false);
    assert.equal(isValidProxyToken('lol', 's3cret'), false);
  });
});
