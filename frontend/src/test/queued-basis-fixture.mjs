import { readFile } from 'node:fs/promises';

/** Operator-mounted synthetic account only; never imported by application code. */
export async function readQueuedBasisFixture() {
  const value = JSON.parse(await readFile('/fixture-owner.json', 'utf8'));
  if (!value || Array.isArray(value) || Object.keys(value).sort().join(',') !== 'login,password' ||
      typeof value.login !== 'string' || !value.login || value.login.length > 256 ||
      typeof value.password !== 'string' || !value.password || value.password.length > 4096) throw new Error('Invalid disposable account fixture');
  return { login: value.login, password: value.password };
}
