import { useState } from 'react';
import { Dialog } from '../../ui/Dialog';
import { Icon } from '../../ui/Icon';
export function NewSchemeDialog({ onCreate, onClose }: { onCreate: (name: string, description: string) => Promise<boolean>; onClose: () => void }) {
  const [name, setName] = useState(''); const [description, setDescription] = useState(''); const [busy, setBusy] = useState(false);
  return <Dialog title="Новая схема сети" onClose={onClose} closeDisabled={busy}><p className="dialog-intro">Создайте рабочую схему. Оборудование и соединения можно добавить из каталога.</p><form className="scheme-form" onSubmit={async e => { e.preventDefault(); if (!name.trim() || busy) return; setBusy(true); const created = await onCreate(name.trim(), description.trim()); setBusy(false); if (created) onClose(); }}>
    <label>Название<input autoFocus required maxLength={200} placeholder="Например, Подстанция Северная" value={name} onChange={e => setName(e.target.value)} /></label>
    <label>Описание <span className="optional-label">необязательно</span><textarea maxLength={2000} rows={3} placeholder="Назначение и особенности сети" value={description} onChange={e => setDescription(e.target.value)} /></label>
    <div className="dialog-actions"><button type="button" className="tool-btn" onClick={onClose} disabled={busy}>Отмена</button><button className="tool-btn primary" disabled={busy || !name.trim()}><Icon name="plus" />{busy ? 'Создание…' : 'Создать схему'}</button></div>
  </form></Dialog>;
}
