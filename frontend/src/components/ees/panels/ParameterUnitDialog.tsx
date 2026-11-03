import { useContext, useEffect, useId, useRef, useState, type FormEvent } from 'react';
import { parseParameterUnitDeclaration, parameterUnitLabel, parameterSourceBase } from '../../../api/parameter-unit-declaration';
import { parameterBaseDraft, type ParameterBase } from '../../../domain/parameter-base';
import { ParameterBaseFields } from '../../ui/ParameterBaseFields';
import type { EditorComponent } from '../editor-utils';
import { Dialog } from '../../ui/Dialog';
import { ParameterFormDraftContext, type ParameterFormDraft } from './parameter-form-draft-context';
import './ParameterUnitDialog.css';

/** A declaration changes the meaning of the supplied value; it never converts it. */
export function ParameterUnitDialog({ component, initialParameterKey, onClose, onSave }: {
  component: EditorComponent; onClose: () => void;
  initialParameterKey?: string;
  onSave: (key: string, value: string, unit: string, base?: ParameterBase) => Promise<void>;
}) {
  const fields = [...new Set([...(component.paramTemplate ?? []).map(field => field.key), ...Object.keys(component.params)])];
  const initial = (key: string) => ({ key, value: Object.prototype.hasOwnProperty.call(component.params, key) ? component.params[key] : '',
    unit: parameterUnitLabel(component.declaredParameterUnits, key, ''),
    power: parameterSourceBase(component.declaredParameterUnits, key)?.s_base_mva.toString() ?? '',
    voltage: parameterSourceBase(component.declaredParameterUnits, key)?.v_base_kv.toString() ?? '' });
  const [draft, setDraft] = useState(() => initial(initialParameterKey ?? fields[0] ?? ''));
  const [source, setSource] = useState(() => ({ id: component.id, revision: component.revision, base: { ...draft } }));
  const journal = useContext(ParameterFormDraftContext);
  const [recovery, setRecovery] = useState<{ value: ParameterFormDraft | null; error: string }>(() => {
    try { return { value: journal?.read(component.id) ?? null, error: '' }; }
    catch { return { value: null, error: 'Сохранённый ввод повреждён или недоступен. Для продолжения явно отбросьте локальный ввод.' }; }
  });
  const [storageError, setStorageError] = useState(''), [committed, setCommitted] = useState(false);
  const [busy, setBusy] = useState(false), [error, setError] = useState('');
  const pending = useRef(false), id = useId();
  const waiting = !!recovery.value || !!recovery.error;
  const dirty = JSON.stringify(draft) !== JSON.stringify(source.base);
  const current = initial(draft.key);
  const changed = component.id !== source.id || component.revision !== source.revision || !fields.includes(draft.key) || JSON.stringify(current) !== JSON.stringify(source.base);
  useEffect(() => {
    if (!journal || waiting || committed) return;
    try {
      journal.save(component.id, dirty ? { sourceRevision: source.revision!, base: source.base, draft } : null);
      setStorageError('');
    } catch { setStorageError('Ввод параметра не сохранён в этой вкладке. Сохраните её открытой; запись на сервер заблокирована.'); }
  }, [journal, waiting, committed, component.id, dirty, draft, source]);
  const reset = (close = false) => {
    try { journal?.save(component.id, null); }
    catch { setStorageError('Не удалось очистить локальный ввод. Повторной записи на сервер не будет.'); return; }
    const next = initial(fields.includes(draft.key) ? draft.key : fields[0] ?? '');
    setDraft(next); setSource({ id: component.id, revision: component.revision, base: next });
    setRecovery({ value: null, error: '' }); setStorageError(''); setError('');
    if (close) onClose();
  };
  const recover = () => {
    if (!recovery.value) return;
    const value = recovery.value;
    setDraft(value.draft); setSource({ id: component.id, revision: value.sourceRevision, base: value.base });
    setRecovery({ value: null, error: '' }); setError('');
  };
  let invalid = '';
  try {
    parseParameterUnitDeclaration({ formatVersion: 1, units: { [draft.key]: draft.unit } }, { [draft.key]: draft.value });
    if (!draft.value.trim() || draft.value.includes('\0') || new TextEncoder().encode(draft.value).length > 16384) invalid = 'Введите значение параметра без подстановки по умолчанию.';
  } catch { invalid = 'Укажите единицу явно: от 1 до 64 символов без окружающих пробелов и управляющих символов.'; }
  if (!invalid && draft.unit === 'p.u.') {
    try { parameterBaseDraft(draft.power, draft.voltage); }
    catch (reason) { invalid = reason instanceof Error ? reason.message : 'Укажите исходные базисы.'; }
  }
  const field = component.paramTemplate?.find(field => field.key === draft.key);
  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (pending.current || waiting || storageError || committed || changed || invalid) return;
    pending.current = true; setBusy(true); setError('');
    try {
      if (draft.unit === 'p.u.') await onSave(draft.key, draft.value, draft.unit, parameterBaseDraft(draft.power, draft.voltage));
      else await onSave(draft.key, draft.value, draft.unit);
      setCommitted(true);
      try { journal?.save(component.id, null); }
      catch { setStorageError('Значение и единица сохранены на сервере, но локальный ввод не очищен. Закройте сохранённую форму; повторная запись заблокирована.'); return; }
      onClose();
    }
    catch (reason) { setError(reason instanceof Error ? reason.message : 'Сохранение значения и единицы не подтверждено.'); }
    finally { pending.current = false; setBusy(false); }
  };
  return <Dialog title="Значение и единица параметра" closeDisabled={busy} onClose={onClose}>
    <p className="dialog-intro">{component.name} · #{component.id}. Значение и единица сохраняются вместе. Число не пересчитывается: при смене единицы задайте соответствующее значение самостоятельно.</p>
    <form className="parameter-unit-form" aria-label="Декларация единицы параметра" onSubmit={submit}>
      {waiting && <section aria-label="Сохранённый ввод параметра">
        <p role="status">{recovery.error || `Есть неприменённый ввод параметра ${recovery.value!.draft.key}. Он не отправлен на сервер.`}</p>
        {recovery.value && <button type="button" className="tool-btn" onClick={recover}>Восстановить ввод параметра</button>}
        <button type="button" className="tool-btn" onClick={() => reset()}>Отбросить локальный ввод параметра</button>
      </section>}
      {storageError && <p role="alert">{storageError}</p>}
      {committed && <button type="button" className="tool-btn" onClick={() => reset(true)}>Закрыть сохранённую форму</button>}
      {changed && !waiting && <section aria-label="Исходное состояние параметра"><p role="alert">Оборудование изменилось после открытия или сохранения ввода. Запись заблокирована. Верните актуальное значение и введите параметр заново.</p>
        <p>Исходное: {source.base.value || 'Не задано'} · {source.base.unit || 'Единица не задана'}{source.base.unit === 'p.u.' ? ` · Sб ${source.base.power || '?'} МВА · Uб ${source.base.voltage || '?'} кВ` : ''}.</p>
        <p>Актуальное: {current.value || 'Не задано'} · {current.unit || 'Единица не задана'}{current.unit === 'p.u.' ? ` · Sб ${current.power || '?'} МВА · Uб ${current.voltage || '?'} кВ` : ''}.</p>
      </section>}
      <fieldset disabled={busy || waiting || committed}>
        <legend>Параметр экземпляра</legend>
        <label htmlFor={`${id}-key`}>Параметр<select id={`${id}-key`} value={draft.key} onChange={event => {
          if (dirty) { setError('Сначала сохраните или явно отбросьте ввод текущего параметра.'); return; }
          const next = initial(event.target.value); setDraft(next); setSource({ id: component.id, revision: component.revision, base: next }); setError('');
        }}>
          {fields.map(key => <option key={key} value={key}>{component.paramTemplate?.find(field => field.key === key)?.name ?? key} · {key}</option>)}
        </select></label>
        <label htmlFor={`${id}-value`}>Значение<input id={`${id}-value`} type="text" value={draft.value} onChange={event => { setDraft({ ...draft, value: event.target.value }); setError(''); }} /></label>
        <label htmlFor={`${id}-unit`}>Единица<input id={`${id}-unit`} type="text" value={draft.unit} placeholder={field?.unit || 'Например: МВт, кВ, Ом или 1'} onChange={event => { setDraft({ ...draft, unit: event.target.value, ...(draft.unit === 'p.u.' && event.target.value !== 'p.u.' ? { power: '', voltage: '' } : {}) }); setError(''); }} /></label>
        {draft.unit === 'p.u.' && <ParameterBaseFields power={draft.power} voltage={draft.voltage} onChange={(field, value) => { setDraft({ ...draft, [field]: value }); setError(''); }} />}
        <p className="dialog-intro">{field?.unit ? `Подсказка текущего шаблона: ${field.unit}. Она не заполняет единицу автоматически.` : 'Для безразмерной величины явно укажите 1, если это соответствует выбранной модели.'} Обозначение и физическую применимость проверяет расчётная модель; сохранение не означает подтверждения достоверности.</p>
        {invalid && <p role="status">{invalid}</p>}
        {error && <p role="alert">{error}</p>}
        {(dirty || changed) && <button type="button" className="tool-btn" onClick={() => reset()}>Вернуть актуальное значение</button>}
        <div className="dialog-actions"><button type="button" className="tool-btn" onClick={() => reset(true)}>Отмена</button><button type="submit" className="tool-btn primary" disabled={changed || !!storageError || !!invalid || !fields.length}>{busy ? 'Сохранение…' : 'Сохранить значение и единицу'}</button></div>
      </fieldset>
    </form>
  </Dialog>;
}
