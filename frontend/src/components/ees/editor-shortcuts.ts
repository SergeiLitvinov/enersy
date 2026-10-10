// Window listeners survive while a private editor is masked for revalidation.
// Hidden/busy contexts must not dispatch writes or steal focus through shortcuts.
export function editorShortcutAllowed(root: HTMLElement | null, target: EventTarget | null): boolean {
  if (!root?.isConnected || root.closest('[hidden], [inert], [aria-busy="true"]')) return false;
  if (!(target instanceof Element)) return false;
  if (target.closest('input, textarea, select, [contenteditable], dialog[open], [role="dialog"], [role="alertdialog"]')) return false;
  return root.contains(target) || target === document.body;
}
