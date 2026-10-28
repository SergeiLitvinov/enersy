import { expect, test } from 'vitest';
import { digestStudySource, parseStudySourceDigest, parseStudySourceRevisions } from './study-source-revisions';
import { vi } from 'vitest';

test('compact digest matches the independent Go/.NET vector and stays fixed size', async () => {
  const { webcrypto } = await vi.importActual<{ webcrypto: Crypto }>('node:crypto');
  vi.stubGlobal('crypto', webcrypto);
  try {
    const source = [{ id: '2', revision: '9007199254740993' }, { id: '10', revision: '1' }];
    expect(await digestStudySource('7', source)).toBe('v1:66bb33f9f6ab4baf8ef55df95d59179f1d4b578b35824c3a7defe5542fb227c0');
    expect(await digestStudySource('8', source)).not.toBe(await digestStudySource('7', source));
    const large = Array.from({ length: 100000 }, (_, i) => ({ id: String(i + 1), revision: '1' }));
    expect((await digestStudySource('7', large)).length).toBe(67);
    for (const bad of [null, '', 'v2:' + 'a'.repeat(64), 'v1:' + 'A'.repeat(64)]) expect(() => parseStudySourceDigest(bad)).toThrow();
  } finally { vi.unstubAllGlobals(); }
});

test('source manifests preserve exact revisions and reject incomplete or ambiguous lists', () => {
  const source = [{ id: '2', revision: '9007199254740993' }];
  expect(parseStudySourceRevisions(source)).toEqual(source);
  expect(parseStudySourceRevisions(source)[0]).not.toBe(source[0]);
  expect(parseStudySourceRevisions([])).toEqual([]);
  for (const value of [null, {}, [{ id: '1' }], [{ id: '01', revision: '1' }], [{ id: '1', revision: 1 }],
    [{ id: '1', revision: '0' }], [{ id: '1', revision: '9223372036854775808' }], [{ id: '2147483648', revision: '1' }],
    [{ id: '2', revision: '1' }, { id: '1', revision: '1' }], [source[0], source[0]], [{ ...source[0], extra: 1 }]])
    expect(() => parseStudySourceRevisions(value)).toThrow();
});
