import { expect, test, vi } from 'vitest';
import { parseParameterBase, sameParameterBase } from '../domain/parameter-base';
import { parsePassportDocument } from '../domain/passport-document';
import { copyParameterUnits, editParameterUnit, parameterSourceBase, parseParameterUnitDeclaration } from './parameter-unit-declaration';
import { copyComponentCreation, requireCreationUnits } from './component-creation';
import { ComponentWrites } from '../components/ees/component-writes';
import { compareComponentDraft } from '../components/ees/component-comparison';
import { prepareRecoveryPatch } from '../components/ees/component-comparison';
import type { SchemeComponent } from './ees-api';
import { encodeEditorDraftPayload, parseEditorDraftPayload } from './editor-draft-payload';
import fixtureJSON from '../../../tests/fixtures/editor-create-units-v1.json?raw';
import basesFixtureJSON from '../../../tests/fixtures/editor-create-bases-v2.json?raw';

const base = { profile: 'ac-three-phase-rms-v1' as const, s_base_mva: 10, v_base_kv: 35 };
const declaration = () => ({ formatVersion: 2 as const, units: { p: 'p.u.' }, bases: { p: { ...base } } });
const component = (): SchemeComponent => ({ id: 1, typeId: 1, type: 'load', name: 'Load', revision: '1', x: 0, y: 0, rotation: 0,
  params: { p: '0.1000' }, declaredParameterUnits: declaration() });

test('source bases have a closed finite positive physical convention', () => {
  expect(parseParameterBase(base)).toEqual(base);
  for (const raw of [null, {}, { ...base, profile: 'unknown' }, { ...base, extra: true },
    ...[0, -1, NaN, Infinity, '10', true, null].flatMap(value => [{ ...base, s_base_mva: value }, { ...base, v_base_kv: value }])]) {
    expect(() => parseParameterBase(raw)).toThrow();
  }
  expect(sameParameterBase(undefined, null)).toBe(true);
  expect(sameParameterBase(base, { ...base, s_base_mva: 100 })).toBe(false);
});

test('v2 parses and copies bases; v1 and dimensional labels cannot silently absorb them', () => {
  const input = declaration(), parsed = parseParameterUnitDeclaration(input, { p: '0.1000' });
  input.bases.p.s_base_mva = 100;
  expect(parsed.bases?.p?.s_base_mva).toBe(10);
  const cloned = copyParameterUnits(parsed); cloned.bases!.p!.s_base_mva = 200;
  expect(parsed.bases?.p?.s_base_mva).toBe(10);
  expect(editParameterUnit(parsed, 'p', 'p.u.')).toEqual(parsed);
  expect(editParameterUnit(parsed, 'p', 'MW')).toEqual({ formatVersion: 1, units: { p: 'MW' } });
  for (const raw of [{ ...declaration(), formatVersion: 1 }, { ...declaration(), units: { p: 'MW' } },
    { ...declaration(), bases: {} }, { ...declaration(), bases: { q: base } }, { ...declaration(), bases: { p: undefined } }]) {
    expect(() => parseParameterUnitDeclaration(raw, { p: '1' })).toThrow();
  }
  expect(parseParameterUnitDeclaration({ ...declaration(), bases: { p: null } }, { p: '1' }).bases?.p).toBeNull();
});

test('prototype parameter names do not invent source bases', () => {
  const declared = { ...declaration(), units: { ...declaration().units, constructor: 'p.u.' } };
  expect(parameterSourceBase(declared, 'constructor')).toBeUndefined();
  const own = parseParameterUnitDeclaration({ formatVersion: 2, units: Object.fromEntries([['__proto__', 'p.u.']]), bases: Object.fromEntries([['__proto__', base]]) }, Object.fromEntries([['__proto__', '0.1000']]));
  expect(parameterSourceBase(own, '__proto__')).toEqual(base);
});

test('creation and durable graph journal retain source basis and reject a changed or absent acknowledgement', () => {
  const shared = JSON.parse(basesFixtureJSON);
  expect(JSON.parse(encodeEditorDraftPayload(parseEditorDraftPayload(shared)))).toEqual(shared);
  const input = { schemeId: 7, typeId: 1, name: 'Load', x: 0, y: 0, rotation: 0, params: { p: '0.1000' }, parameterUnitDeclaration: declaration() };
  const copied = copyComponentCreation(input); input.parameterUnitDeclaration.bases.p.s_base_mva = 100;
  expect(copied.parameterUnitDeclaration?.bases?.p).toEqual(base);
  for (const units of [undefined, { formatVersion: 1 as const, units: { p: 'p.u.' } }, declaration()]) {
    const changed = units ? copyParameterUnits(units) : undefined;
    if (changed?.bases?.p) changed.bases.p.s_base_mva = 100;
    expect(() => requireCreationUnits(copied.parameterUnitDeclaration, copied.params, { params: copied.params, declaredParameterUnits: changed })).toThrow();
  }
  expect(() => requireCreationUnits(copied.parameterUnitDeclaration, copied.params, { params: copied.params, declaredParameterUnits: declaration() })).not.toThrow();
  const journal = JSON.parse(fixtureJSON);
  journal.graph[0].intent.params = { p: '0.1000' }; journal.graph[0].intent.parameterUnitDeclaration = declaration();
  expect(JSON.parse(encodeEditorDraftPayload(parseEditorDraftPayload(journal)))).toEqual(journal);
});

test('lost acknowledgement cannot replay a coefficient against a changed source basis', async () => {
  const queue = new ComponentWrites(), source = component(); queue.seed(1, source);
  const ticket = queue.drafts.record(1, source, { kind: 'parameter', key: 'p', value: '0.2000', unit: 'p.u.' });
  queue.drafts.fail(ticket, 'Lost acknowledgement');
  const server = { ...component(), revision: '8', params: { p: '0.2000' } };
  server.declaredParameterUnits!.bases!.p!.s_base_mva = 100;
  const review = queue.drafts.failed(1)[0], apply = vi.fn();
  expect(compareComponentDraft(review, server)[0].status).toBe('unit_changed');
  await expect(queue.recover(review, server, new Set(['parameter:p']), () => true, apply)).rejects.toThrow('базис');
  expect(apply).not.toHaveBeenCalled();
  source.declaredParameterUnits!.bases!.p!.s_base_mva = 500;
  expect(queue.drafts.snapshot(1)[0].base.declaredParameterUnits?.bases?.p).toEqual(base);
  // An intent arriving while accepting the compared state keeps its original basis.
  queue.drafts.record(1, component(), { kind: 'parameter', key: 'p', value: '0.3000' });
  queue.drafts.resolveReviewed(review, new Set(['parameter:p']), server);
  expect(queue.drafts.failed(1)[0].base.declaredParameterUnits?.bases?.p).toEqual(base);
});

test('acknowledging an ordinary same-unit edit retains its source basis', () => {
  const queue = new ComponentWrites(), source = component(); queue.seed(1, source);
  const ticket = queue.drafts.record(1, source, { kind: 'parameter', key: 'p', value: '0.2000', unit: 'p.u.' });
  const next = queue.drafts.record(1, source, { kind: 'parameter', key: 'p', value: '0.3000' });
  queue.drafts.acknowledge(ticket, '2'); queue.drafts.fail(next, 'Lost acknowledgement');
  expect(queue.drafts.failed(1)[0].base).toMatchObject({ params: { p: '0.2000' }, declaredParameterUnits: declaration() });
});

test('explicit basis edit and clear survive capture and replay exactly once', async () => {
  for (const target of [{ ...base, s_base_mva: 100 }, null]) {
    const queue = new ComponentWrites(), source = component(); queue.seed(1, source);
    const ticket = queue.drafts.record(1, source, { kind: 'parameter', key: 'p', value: '0.1000', unit: 'p.u.', base: target });
    queue.drafts.fail(ticket, 'Lost acknowledgement');
    const review = queue.drafts.failed(1)[0];
    const patch = prepareRecoveryPatch(review, source, new Set(['parameter:p'])).patch;
    expect(patch).toEqual({ params: { p: '0.1000' }, parameterUnitDeclaration: { formatVersion: 2, units: { p: 'p.u.' }, bases: { p: target } } });
    if (target) target.s_base_mva = 500; // Captured intent owns its base object.
    expect(review.intents[0]).toMatchObject({ base: target ? { ...base, s_base_mva: 100 } : null });
    const apply = vi.fn().mockResolvedValue({ success: true, revision: '8' });
    const confirmed = await queue.recover(review, source, new Set(['parameter:p']), () => true, apply);
    expect(apply).toHaveBeenCalledOnce();
    expect(confirmed?.declaredParameterUnits?.bases?.p ?? null).toEqual(target ? { ...base, s_base_mva: 100 } : null);
    const restored = { ...review, base: component() };
    expect(compareComponentDraft(restored, confirmed)[0].status).toBe('already_applied');
  }
});

test('passport v2 retains source basis while v1 rejects it', () => {
  const doc = { formatVersion: 2, componentTypeCode: 'load', name: 'Own data', manufacturer: '', source: 'Test', license: 'MIT',
    parameters: { p: { value: '0.1000', unit: 'p.u.', base: { ...base } } } };
  const parsed = parsePassportDocument(doc); doc.parameters.p.base.s_base_mva = 100;
  expect(parsed.parameters.p.base).toEqual(base);
  expect(() => parsePassportDocument({ ...doc, formatVersion: 1 })).toThrow();
  expect(() => parsePassportDocument({ ...doc, parameters: { p: { ...doc.parameters.p, unit: 'MW' } } })).toThrow();
});
