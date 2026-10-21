import { useRef, useState } from 'react';
import { Dialog } from '../../ui/Dialog';
import { Icon } from '../../ui/Icon';
export function NewSchemeDialog({ onCreate, onClose }: { onCreate: (name: string, description: string) => Promise<boolean>; onClose: () => void }) {
  const [name, setName] = useState(''); const [description, setDescription] = useState(''); const [busy, setBusy] = useState(false);
  const submitting = useRef(false);
  const [error, setError] = useState('');
  async function submit(event: React.FormEvent) {
    event.preventDefault();
    if (!name.trim() || submitting.current) return;
    submitting.current = true; setBusy(true); setError('');
    try {
      if (await onCreate(name.trim(), description.trim())) onClose();
      else setError('Не удалось создать схему. Проверьте список схем перед повторной попыткой.');
    } catch {
      setError('Не удалось создать схему. Проверьте список схем перед повторной попыткой.');
    } finally { submitting.current = false; setBusy(false); }
  }
  return <Dialog title="Новая схема сети" onClose={onClose} closeDisabled={busy}><p className="dialog-intro">Создайте рабочую схему. Оборудование и соединения можно добавить из каталога.</p><form className="scheme-form" onSubmit={submit}>
    <label>Название<input autoFocus required maxLength={200} placeholder="Например, Подстанция Северная" value={name} onChange={e => setName(e.target.value)} /></label>
    <label>Описание <span className="optional-label">необязательно</span><textarea maxLength={2000} rows={3} placeholder="Назначение и особенности сети" value={description} onChange={e => setDescription(e.target.value)} /></label>
    {error && <p role="alert">{error}</p>}
    <div className="dialog-actions"><button type="button" className="tool-btn" onClick={onClose} disabled={busy}>Отмена</button><button className="tool-btn primary" disabled={busy || !name.trim()}><Icon name="plus" />{busy ? 'Создание…' : 'Создать схему'}</button></div>
  </form></Dialog>;
}
