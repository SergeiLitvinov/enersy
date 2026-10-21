// @vitest-environment jsdom
import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { TerminalInspector, ConnectionInspector } from './TerminalInspector';
const components = [{ id: 1, type: 'generator', name: 'G' }, { id: 2, type: 'transmission_line', name: 'Line' }];
const connections = [{ id: 7, from: 1, to: 2, fromPort: 'bottom', toPort: 'left' }];
let host: HTMLDivElement; let root: ReturnType<typeof createRoot>;
beforeEach(() => { Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true }); host = document.createElement('div'); document.body.append(host); root = createRoot(host); });
afterEach(async () => { await act(async () => root.unmount()); host.remove(); });
test('source aliases share one terminal and navigation retains exact object/connection identities', async () => {
  const selectObject = vi.fn(); const selectEdge = vi.fn();
  await act(async () => root.render(<TerminalInspector component={components[0]} components={components} connections={connections} onSelectComponent={selectObject} onSelectConnection={selectEdge} />));
  expect(host.querySelectorAll('.terminal-card')).toHaveLength(1); expect(host.textContent).toContain('Порты: top, bottom'); expect(host.textContent).toContain('Терминал 1 · порт left');
  const buttons = host.querySelectorAll('button');
  await act(async () => { buttons[0].click(); buttons[1].click(); }); expect(selectEdge).toHaveBeenCalledWith(7); expect(selectObject).toHaveBeenCalledWith(2);
});
test('connection details keep unresolved endpoints and server diagnostics visible', async () => {
  await act(async () => root.render(<ConnectionInspector connectionId={7} components={[components[0]]} connections={[{ ...connections[0], fromPort: 'unknown', validationErrors: ['unknown_port'] }]} />));
  expect(host.textContent).toContain('Неизвестный порт'); expect(host.textContent).toContain('Объект отсутствует'); expect(host.textContent).toContain('unknown_port'); expect(host.textContent).not.toContain('Терминал 1');
});
test('unknown local ports are reported instead of being silently grouped into terminal one', async () => {
  await act(async () => root.render(<TerminalInspector component={components[0]} components={components} connections={[{ ...connections[0], fromPort: 'missing' }]} />));
  expect(host.textContent).toContain('#7 (missing)'); expect(host.textContent).toContain('Терминал не подставлен');
});
test('a removed selected connection does not display stale endpoints', async () => {
  await act(async () => root.render(<ConnectionInspector connectionId={7} components={components} connections={connections} />));
  await act(async () => root.render(<ConnectionInspector connectionId={7} components={components} connections={[]} />));
  expect(host.textContent).toContain('Связь отсутствует'); expect(host.textContent).not.toContain('Line');
});
