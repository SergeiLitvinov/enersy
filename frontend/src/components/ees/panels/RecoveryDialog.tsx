import { useEffect, useRef, useState } from 'react';
import { getScheme, type SchemeComponent } from '../../../api/ees-api';
import { Dialog } from '../../ui/Dialog';
import type { ComponentDraft } from '../component-drafts';
import { compareComponentDraft, type ComponentComparisonRow } from '../component-comparison';

const statusLabels: Record<ComponentComparisonRow['status'], string> = {
  pending: 'Можно сверить с исходной версией', server_changed: 'Изменено на сервере',
  already_applied: 'Уже совпадает', object_missing: 'Объект удалён',
};
const display = (value: ComponentComparisonRow['base']) => value === undefined ? 'Не задано'
  : value === '' ? 'Пустая строка' : typeof value === 'boolean' ? value ? 'Да' : 'Нет' : String(value);

export function RecoveryDialog({ draft, onClose, onResolve, onResolveDeletion }: { draft: ComponentDraft; onClose: () => void;
  onResolve?: (draft: ComponentDraft, server: SchemeComponent, fields: ReadonlySet<string>, mode: 'apply' | 'accept') => Promise<void>;
  onResolveDeletion?: (draft: ComponentDraft, server: SchemeComponent | undefined, mode: 'keep' | 'delete') => Promise<void> }) {
  const [server, setServer] = useState<SchemeComponent>();
  const [busy, setBusy] = useState(true);
  const [error, setError] = useState('');
  const [request, refresh] = useState(0);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [saving, setSaving] = useState(false);
  const [actionError, setActionError] = useState('');
  const [deleteConfirmed, setDeleteConfirmed] = useState(false);
  const actionView = useRef<object>({});
  useEffect(() => {
    setSaving(false); setActionError('');
    return () => { actionView.current = {}; };
  }, [draft.schemeId, draft.componentId]);
  useEffect(() => {
    let active = true;
    setBusy(true); setError(''); setServer(undefined); setSelected(new Set()); setDeleteConfirmed(false);
    getScheme(draft.schemeId).then(scheme => {
      if (active) setServer(scheme.components?.find(component => component.id === draft.componentId));
    }).catch(reason => {
      if (active) setError(reason instanceof Error ? reason.message : 'Не удалось загрузить актуальную схему');
    }).finally(() => { if (active) setBusy(false); });
    return () => { active = false; };
  }, [draft, request]);
  const rows = compareComponentDraft(draft, server);
  const hasDeletion = draft.intents.some(intent => intent.kind === 'delete');
  const perform = async (action: () => Promise<void>) => {
    if (saving) return;
    const view = actionView.current;
    setSaving(true); setActionError('');
    try { await action(); if (actionView.current === view) refresh(value => value + 1); }
    catch (reason) { if (actionView.current === view) { setActionError(reason instanceof Error ? reason.message : 'Не удалось разрешить правки'); refresh(value => value + 1); } }
    finally { if (actionView.current === view) setSaving(false); }
  };
  const resolve = (mode: 'apply' | 'accept') => {
    if (!server || !onResolve || !selected.size) return;
    return perform(() => onResolve(draft, server, new Set(selected), mode));
  };
  const resolveDeletion = (mode: 'keep' | 'delete') => {
    if (!onResolveDeletion || !hasDeletion || busy || error || (mode === 'keep' && !server) || (mode === 'delete' && server && !deleteConfirmed)) return;
    return perform(() => onResolveDeletion(draft, server, mode));
  };
  return <Dialog wide closeDisabled={saving} title={`Сверка правок — ${draft.base.name}`} onClose={onClose}>
    <p className="dialog-intro">Оборудование #{draft.componentId}. Первоначальная версия {draft.base.revision}; {busy ? 'актуальная версия проверяется' : error ? 'актуальная версия не загружена' : server ? `версия сервера ${server.revision}` : 'объект отсутствует на сервере'}. После частичного разрешения база сравнения учитывает принятые значения отдельных полей. Закрытие окна сохраняет оставшиеся правки.</p>
    <p className="result-notice">{draft.reason}</p>
    {busy ? <p role="status">Загрузка актуального состояния…</p> : error ? <p role="alert">{error}</p> : <>
      {!server && <p role="status">Объект отсутствует в актуальной схеме. Его восстановление требует отдельного решения.</p>}
      <div className="results-table-wrap"><table className="results-table recovery-table"><caption>Исходное состояние, ваши правки и сервер</caption>
        <thead><tr><th scope="col">Поле</th><th scope="col">База сравнения</th><th scope="col">Ваше</th><th scope="col">Сервер</th><th scope="col">Состояние</th></tr></thead>
        <tbody>{rows.map(row => <tr key={row.key}><th scope="row"><label><input type="checkbox" aria-label={`Выбрать: ${row.label}`} checked={selected.has(row.key)} disabled={!onResolve || !server || row.key === 'delete' || saving} onChange={event => setSelected(previous => { const next = new Set(previous); if (event.target.checked) next.add(row.key); else next.delete(row.key); return next; })} /> {row.label}</label></th><td>{display(row.base)}</td><td>{display(row.local)}</td><td>{display(row.server)}</td><td>{statusLabels[row.status]}</td></tr>)}</tbody>
      </table></div>
      {rows.length === 0 && <p>В журнале нет изменённых полей положения; подтверждение операции всё равно требует проверки.</p>}
      <p className="dialog-intro">Выберите поля. «Применить мои значения» сохранит их на сервере; «Принять серверные» снимет только выбранные локальные правки. Остальные сохранятся в журнале. Удаление разрешается отдельно.</p>
      {hasDeletion && <section aria-label="Разрешение удаления" className="result-notice recovery-deletion">
        <p>Неподтверждённое удаление рассматривается отдельно. Правки полей останутся в журнале.</p>
        {server ? <>
          <p>Повторное удаление уберёт оборудование и его соединения. Восстановление через undo пока недоступно.</p>
          <label><input type="checkbox" checked={deleteConfirmed} disabled={saving || !onResolveDeletion} onChange={event => setDeleteConfirmed(event.target.checked)} /> Подтверждаю удаление оборудования #{draft.componentId} по версии {server.revision}</label>
          <div className="dialog-actions recovery-actions"><button className="tool-btn" disabled={saving || !onResolveDeletion} onClick={() => { void resolveDeletion('keep'); }}>Оставить объект на сервере</button><button className="tool-btn" disabled={saving || !onResolveDeletion || !deleteConfirmed} onClick={() => { void resolveDeletion('delete'); }}>Удалить по серверной версии</button></div>
        </> : <><p>Объект уже отсутствует. Подтверждение снимет только рассмотренное намерение удаления, без запроса DELETE.</p><button className="tool-btn" disabled={saving || !onResolveDeletion} onClick={() => { void resolveDeletion('delete'); }}>Подтвердить отсутствие объекта</button></>}
      </section>}
    </>}
    {actionError && <p role="alert">{actionError}</p>}
    {saving && <p role="status">Разрешение выбранных правок…</p>}
    <div className="dialog-actions recovery-actions"><button className="tool-btn primary" disabled={busy || saving || !selected.size || !onResolve} onClick={() => { void resolve('apply'); }}>Применить мои значения</button><button className="tool-btn" disabled={busy || saving || !selected.size || !onResolve} onClick={() => { void resolve('accept'); }}>Принять серверные</button><button className="tool-btn" disabled={busy || saving} onClick={() => { setActionError(''); refresh(value => value + 1); }}>Обновить сравнение</button><button className="tool-btn" disabled={saving} onClick={onClose}>Оставить правки в журнале</button></div>
  </Dialog>;
}
