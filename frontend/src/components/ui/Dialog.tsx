import { useEffect, useRef, type ReactNode } from 'react';
import { Icon } from './Icon';
export function Dialog({ title, children, onClose, wide = false, closeDisabled = false }: { title: string; children: ReactNode; onClose: () => void; wide?: boolean; closeDisabled?: boolean }) {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => { const dialog = ref.current; dialog?.showModal(); return () => dialog?.close(); }, []);
  return <dialog ref={ref} className={`workspace-dialog ${wide ? 'wide' : ''}`} aria-label={title} onCancel={e => { if (closeDisabled) e.preventDefault(); else onClose(); }}>
    <div className="dialog-header"><h2>{title}</h2><button className="icon-button" aria-label="Закрыть диалог" onClick={onClose} disabled={closeDisabled}><Icon name="close" /></button></div>
    <div className="dialog-body">{children}</div>
  </dialog>;
}
