// @vitest-environment jsdom
import { afterEach, expect, test } from 'vitest';
import { editorShortcutAllowed } from './editor-shortcuts';
afterEach(() => { document.body.innerHTML = ''; });
function context() {
  const wrapper = document.createElement('div');
  const root = document.createElement('div'); const button = document.createElement('button');
  root.append(button); wrapper.append(root); document.body.append(wrapper);
  return { wrapper, root, button };
}
test('a visible editor accepts its controls and neutral body focus', () => {
  const { root, button } = context();
  expect(editorShortcutAllowed(root, button)).toBe(true);
  expect(editorShortcutAllowed(root, document.body)).toBe(true);
});
test('masked, inert and closing ancestors disable global editor shortcuts', () => {
  const { wrapper, root, button } = context();
  for (const [attribute, value] of [['hidden', ''], ['inert', ''], ['aria-busy', 'true']]) {
    wrapper.setAttribute(attribute, value);
    expect(editorShortcutAllowed(root, button)).toBe(false);
    expect(editorShortcutAllowed(root, document.body)).toBe(false);
    wrapper.removeAttribute(attribute);
  }
});
test('typing, modal controls and other workspace controls cannot trigger editor writes', () => {
  const { root } = context();
  const input = document.createElement('input'); root.append(input);
  const modal = document.createElement('dialog'); modal.open = true; root.append(modal);
  const button = document.createElement('button'); modal.append(button);
  const other = document.createElement('button'); document.body.append(other);
  const accessibleModal = document.createElement('div'); accessibleModal.setAttribute('role', 'dialog'); root.append(accessibleModal);
  for (const target of [input, button, accessibleModal, other, window, null]) expect(editorShortcutAllowed(root, target)).toBe(false);
});
test('unmounted editors never process global shortcuts', () => {
  const { root, button } = context(); root.remove();
  expect(editorShortcutAllowed(root, button)).toBe(false);
  expect(editorShortcutAllowed(null, document.body)).toBe(false);
});
