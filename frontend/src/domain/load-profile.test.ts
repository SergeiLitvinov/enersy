import { expect, test } from 'vitest';
import { loadProfileDraft, loadProfileError, loadProfilePatch } from './load-profile';

const zip = () => loadProfileDraft({ p: '10', q: '3', voltage_nom: '10', zip_enabled: 'true', zip_p_z: '.2', zip_p_i: '.3', zip_p_p: '.5', zip_q_z: '.4', zip_q_i: '.1', zip_q_p: '.5' });
test('preserves entered numbers and applies PQ while clearing inactive ZIP fractions', () => {
  const draft = zip(); draft.p = '1.2345678901234567e1';
  expect(loadProfilePatch(draft).p).toBe(draft.p);
  draft.zip_enabled = 'false';
  expect(loadProfilePatch(draft)).toMatchObject({ zip_p_z: '', zip_q_p: '', zip_enabled: 'false', p: draft.p });
  expect(loadProfileError(loadProfileDraft({ p: '10' }))).toBeUndefined();
});
test.each([{ p: 'NaN' }, { p: '0x10' }, { q: '3,2' }, { voltage_nom: '' }, { voltage_nom: '0' }, { zip_p_z: '-.1' }, { zip_q_p: '.6' }, { zip_p_i: '' }, { zip_enabled: 'custom' }])('rejects unsupported or incomplete input %j', patch => {
  expect(() => loadProfilePatch({ ...zip(), ...patch })).toThrow();
});
