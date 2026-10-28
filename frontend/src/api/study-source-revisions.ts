export type StudySourceRevision = { id: string; revision: string };

export function parseStudySourceDigest(value: unknown): string {
  if (typeof value !== 'string' || value.length !== 67 || !/^v1:[0-9a-f]{64}$/.test(value)) throw new Error('Некорректный отпечаток источника');
  return value;
}

/** Same canonical ASCII stream as the Go v1 contract; revisions never become numbers. */
export async function digestStudySource(scheme: string, revisions: StudySourceRevision[]): Promise<string> {
  if (!/^[1-9][0-9]{0,9}$/.test(scheme) || String(BigInt(scheme)) !== scheme || BigInt(scheme) > 2147483647n) throw new Error('Некорректная схема источника');
  const source = parseStudySourceRevisions(revisions);
  const bytes = new TextEncoder().encode(`enersy-study-source-v1\n${scheme}\n` + source.map(item => `${item.id}:${item.revision}\n`).join(''));
  const hash = await crypto.subtle.digest('SHA-256', bytes);
  return 'v1:' + [...new Uint8Array(hash)].map(value => value.toString(16).padStart(2, '0')).join('');
}

/** Full ordered source manifest. Never infer a missing equipment revision. */
export function parseStudySourceRevisions(value: unknown): StudySourceRevision[] {
  if (!Array.isArray(value) || value.length > 100000) throw new Error('Некорректный список ревизий оборудования');
  let previous = 0n;
  return value.map(item => {
    if (!item || typeof item !== 'object' || Array.isArray(item) || Object.keys(item).some(k => k !== 'id' && k !== 'revision') ||
        typeof item.id !== 'string' || !/^[1-9][0-9]{0,9}$/.test(item.id) || String(BigInt(item.id)) !== item.id || BigInt(item.id) > 2147483647n || BigInt(item.id) <= previous ||
        typeof item.revision !== 'string' || !/^[1-9][0-9]{0,18}$/.test(item.revision) || String(BigInt(item.revision)) !== item.revision || BigInt(item.revision) > 9223372036854775807n)
      throw new Error('Некорректный список ревизий оборудования');
    previous = BigInt(item.id);
    return { id: item.id, revision: item.revision };
  });
}
