import { describe, expect, it } from 'vitest';

import { signToken, verifyToken } from './mock-api';

// The contract §1 test vectors: the dev mock signs tokens exactly like the API.
const SECRET = 'test-cdn-token-secret';

describe('mock API tokens match contract §1', () => {
  it.each([
    [
      { e: 1795603600, k: 'file', s: 'unlock', t: '1234567890123456789', u: 1795600000, v: 0 },
      'eyJlIjoxNzk1NjAzNjAwLCJrIjoiZmlsZSIsInMiOiJ1bmxvY2siLCJ0IjoiMTIzNDU2Nzg5MDEyMzQ1Njc4OSIsInUiOjE3OTU2MDAwMDAsInYiOjB9.PsqqCMSrEKpmQoEe1y5Sof1fZadAnlzQdnW7ygtxuLk',
    ],
    [
      { e: 1796204800, k: 'album', s: 'unlock', t: '987654321098765432', u: 1795600000, v: 3 },
      'eyJlIjoxNzk2MjA0ODAwLCJrIjoiYWxidW0iLCJzIjoidW5sb2NrIiwidCI6Ijk4NzY1NDMyMTA5ODc2NTQzMiIsInUiOjE3OTU2MDAwMDAsInYiOjN9.363h20AIfnXPJ20FngplD6_ARO_pidniwnoIaD0Lebk',
    ],
    [
      { e: 1795603600, k: 'file', s: 'owner', t: '1234567890123456789', u: 1795600000, v: 2 },
      'eyJlIjoxNzk1NjAzNjAwLCJrIjoiZmlsZSIsInMiOiJvd25lciIsInQiOiIxMjM0NTY3ODkwMTIzNDU2Nzg5IiwidSI6MTc5NTYwMDAwMCwidiI6Mn0.S7b7xKQg5Cu19qkZa4BGRNLeZgwmnVmqGjN_1p4nFiE',
    ],
  ] as const)('signs %o', (claims, token) => {
    expect(signToken(claims, SECRET)).toBe(token);
    expect(verifyToken(token, SECRET)).toEqual(claims);
  });

  it('rejects the tampered vector', () => {
    const tampered =
      'eyJlIjoxNzk1NjAzNjAwLCJrIjoiZmlsZSIsInMiOiJ1bmxvY2siLCJ0IjoiMTIzNDU2Nzg5MDEyMzQ1Njc4OSIsInUiOjE3OTU2MDAwMDAsInYiOjF9.PsqqCMSrEKpmQoEe1y5Sof1fZadAnlzQdnW7ygtxuLk';
    expect(verifyToken(tampered, SECRET)).toBeNull();
  });
});
