import { describe, expect, it } from 'vitest';

import { apiRequestUrl, buildSharexConfig, curlSnippet, NO_SHAREX_DEFAULTS, sharexArguments, sharexFilename, uploadUrl } from './sharex';

const KEY = 'fgg_0123456789ABCDEFGHIJabcdefghij3YJC0V';

describe('ShareX .sxcu (milestone-6 §7.7)', () => {
  it('matches the contract example exactly, key order included', () => {
    const args = sharexArguments({ expiresIn: 604800, visibility: 'password', generatePassword: true, nsfw: false, album: 'Ab3dE6gH' }, true);
    const config = buildSharexConfig({ keyName: 'Laptop ShareX', secret: KEY, args });
    expect(JSON.stringify(config, null, 2)).toBe(`{
  "Version": "17.0.0",
  "Name": "files.gg (Laptop ShareX)",
  "DestinationType": "ImageUploader, TextUploader, FileUploader",
  "RequestMethod": "POST",
  "RequestURL": "https://api.files.gg/files",
  "Headers": {
    "Authorization": "Key ${KEY}"
  },
  "Body": "MultipartFormData",
  "Arguments": {
    "expires_in": "604800",
    "visibility": "password",
    "generate_password": "true",
    "album": "Ab3dE6gH"
  },
  "FileFormName": "file",
  "URL": "{json:url_with_password}",
  "ErrorMessage": "{json:message}"
}`);
  });

  it('omits Arguments when nothing was picked, and uses {json:url} without a generated password', () => {
    const config = buildSharexConfig({ keyName: 'k', secret: KEY, args: sharexArguments(NO_SHAREX_DEFAULTS, false) });
    expect(Object.keys(config)).toEqual(['Version', 'Name', 'DestinationType', 'RequestMethod', 'RequestURL', 'Headers', 'Body', 'FileFormName', 'URL', 'ErrorMessage']);
    expect(config.URL).toBe('{json:url}');
    expect(config).not.toHaveProperty('DeletionURL');
    expect(config).not.toHaveProperty('ThumbnailURL');
  });

  it('puts only picked defaults in Arguments: nsfw as "true", album only with albums:append', () => {
    expect(sharexArguments({ ...NO_SHAREX_DEFAULTS, nsfw: true, album: 'Ab3dE6gH' }, false)).toEqual({ nsfw: 'true' });
    expect(sharexArguments({ ...NO_SHAREX_DEFAULTS, visibility: 'private', generatePassword: true }, false)).toEqual({ visibility: 'private' });
    expect(sharexArguments({ ...NO_SHAREX_DEFAULTS, visibility: 'password', generatePassword: true }, false)).toEqual({ visibility: 'password', generate_password: 'true' });
  });

  it('adds the view limit and its action last (milestone-6 §19.3), only with a limit', () => {
    expect(sharexArguments({ ...NO_SHAREX_DEFAULTS, expiresIn: 3600, viewLimit: 3 }, false)).toEqual({ expires_in: '3600', view_limit: '3', view_limit_action: 'expire' });
    expect(Object.keys(sharexArguments({ ...NO_SHAREX_DEFAULTS, nsfw: true, viewLimit: 1, viewLimitAction: 'private' }, false))).toEqual(['nsfw', 'view_limit', 'view_limit_action']);
    expect(sharexArguments({ ...NO_SHAREX_DEFAULTS, viewLimit: null, viewLimitAction: 'private' }, false)).toEqual({});
  });

  it('names the download "files.gg - <key name>.sxcu", safely', () => {
    expect(sharexFilename('Laptop ShareX')).toBe('files.gg - Laptop ShareX.sxcu');
    expect(sharexFilename('a/b:c')).toBe('files.gg - a_b_c.sxcu');
    expect(sharexFilename('  ')).toBe('files.gg - Upload key.sxcu');
  });

  it('builds the curl snippet with the same arguments as -F fields, against the API origin', () => {
    expect(uploadUrl()).toBe('https://api.files.gg/files');
    expect(curlSnippet({ secret: KEY, args: { expires_in: '604800' } })).toBe(
      `curl -H "Authorization: Key ${KEY}" \\\n     -F "file=@photo.png" -F "expires_in=604800" \\\n     https://api.files.gg/files`,
    );
  });

  it("uses the API's RequestURL when https, or http on an http page (the local stack); else api.files.gg", () => {
    const local = { RequestURL: 'http://api.files.localhost:8787/files' };
    expect(apiRequestUrl({ RequestURL: 'https://api.example.test/files' }, 'https:')).toBe('https://api.example.test/files');
    expect(apiRequestUrl(local, 'http:')).toBe('http://api.files.localhost:8787/files');
    expect(apiRequestUrl(local, 'https:')).toBe('https://api.files.gg/files');
    expect(apiRequestUrl({ RequestURL: 'javascript:alert(1)' }, 'http:')).toBe('https://api.files.gg/files');
    expect(apiRequestUrl({ RequestURL: 42 }, 'https:')).toBe('https://api.files.gg/files');
    expect(apiRequestUrl(undefined, 'https:')).toBe('https://api.files.gg/files');
  });
});
