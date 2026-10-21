import { expect, test } from 'vitest';
import fixtureJSON from '../../../tests/fixtures/editor-draft-passport-v2.json?raw';
import { parseEditorDraftPayloadV2 } from './editor-draft-phases';
import { captureEditorJournal, restoreProjectEditorJournal } from '../features/projects/editor-journal';

test('shared Go/TypeScript fixture preserves passport in object bases and both creation phases through restore', () => {
  const fixture = JSON.parse(fixtureJSON);
  expect(parseEditorDraftPayloadV2(fixture)).toEqual(fixture);
  const restored = restoreProjectEditorJournal({ projectId: '1', schemeId: '1', name: 'Fixture', writable: true, signal: new AbortController().signal }, fixture);
  expect(captureEditorJournal(restored.queue, '1')).toEqual(fixture);
  for (const value of [0, '0', '9223372036854775808']) {
    expect(() => parseEditorDraftPayloadV2(JSON.parse(fixtureJSON.split('"9007199254740993"').join(JSON.stringify(value))))).toThrow();
  }
  expect(() => parseEditorDraftPayloadV2(JSON.parse(fixtureJSON.split('"equipmentModelId": null').join('"equipmentModelId": "2"')))).toThrow();
});
