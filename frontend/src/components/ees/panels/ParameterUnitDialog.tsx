import { useId, useRef, useState, type FormEvent } from 'react';
import { parseParameterUnitDeclaration, parameterUnitLabel } from '../../../api/parameter-unit-declaration';
import type { EditorComponent } from '../editor-utils';
import { Dialog } from '../../ui/Dialog';
import './ParameterUnitDialog.css';

/** A declaration changes the meaning of the supplied value; it never converts it. */
export function ParameterUnitDialog({ component, onClose, onSave }: {
  component: EditorComponent; onClose: () => void;
  onSave: (key: string, value: string, unit: string) => Promise<void>;
}) {
  const fields = [...new Set([...(component.paramTemplate ?? []).map(field => field.key), ...Object.keys(component.params)])];
  const initial = (key: string) => ({ key, value: Object.prototype.hasOwnProperty.call(component.params, key) ? component.params[key] : '',
    unit: parameterUnitLabel(component.declaredParameterUnits, key, '') });
  const [draft, setDraft] = useState(() => initial(fields[0] ?? ''));
  const [source] = useState(() => ({ id: component.id, revision: component.revision }));
  const [busy, setBusy] = useState(false), [error, setError] = useState('');
  const pending = useRef(false), id = useId();
  const changed = component.id !== source.id || component.revision !== source.revision || !fields.includes(draft.key);
  let invalid = '';
  try {
    parseParameterUnitDeclaration({ formatVersion: 1, units: { [draft.key]: draft.unit } }, { [draft.key]: draft.value });
    if (!draft.value.trim() || draft.value.includes('\0') || new TextEncoder().encode(draft.value).length > 16384) invalid = 'Введите значение параметра без подстановки по умолчанию.';
  } catch { invalid = 'Укажите единицу явно: от 1 до 64 символов без окружающих пробелов и управляющих символов.'; }
  const field = component.paramTemplate?.find(field => field.key === draft.key);
  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (pending.current || changed || invalid) return;
    pending.current = true; setBusy(true); setError('');
    try { await onSave(draft.key, draft.value, draft.unit); onClose(); }
    catch (reason) { setError(reason instanceof Error ? reason.message : 'Сохранение значения и единицы не подтверждено.'); }
    finally { pending.current = false; setBusy(false); }
  };
  return <Dialog title="Значение и единица параметра" closeDisabled={busy} onClose={onClose}>
    <p className="dialog-intro">{component.name} · #{component.id}. Значение и единица сохраняются вместе. Число не пересчитывается: при смене единицы задайте соответствующее значение самостоятельно.</p>
    <form className="parameter-unit-form" aria-label="Декларация единицы параметра" onSubmit={submit}>
      <fieldset disabled={busy}>
        <legend>Параметр экземпляра</legend>
        <label htmlFor={`${id}-key`}>Параметр<select id={`${id}-key`} value={draft.key} onChange={event => { setDraft(initial(event.target.value)); setError(''); }}>
          {fields.map(key => <option key={key} value={key}>{component.paramTemplate?.find(field => field.key === key)?.name ?? key} · {key}</option>)}
        </select></label>
        <label htmlFor={`${id}-value`}>Значение<input id={`${id}-value`} type="text" value={draft.value} onChange={event => { setDraft({ ...draft, value: event.target.value }); setError(''); }} /></label>
        <label htmlFor={`${id}-unit`}>Единица<input id={`${id}-unit`} type="text" value={draft.unit} placeholder={field?.unit || 'Например: МВт, кВ, Ом или 1'} onChange={event => { setDraft({ ...draft, unit: event.target.value }); setError(''); }} /></label>
        <p className="dialog-intro">{field?.unit ? `Подсказка текущего шаблона: ${field.unit}. Она не заполняет единицу автоматически.` : 'Для безразмерной величины явно укажите 1, если это соответствует выбранной модели.'} Обозначение и физическую применимость проверяет расчётная модель; сохранение не означает подтверждения достоверности.</p>
        {changed && <p role="alert">Оборудование изменилось после открытия окна. Закройте его и заново проверьте актуальные значение и единицу.</p>}
        {invalid && <p role="status">{invalid}</p>}
        {error && <p role="alert">{error}</p>}
        <div className="dialog-actions"><button type="button" className="tool-btn" onClick={onClose}>Отмена</button><button type="submit" className="tool-btn primary" disabled={changed || !!invalid || !fields.length}>{busy ? 'Сохранение…' : 'Сохранить значение и единицу'}</button></div>
      </fieldset>
    </form>
  </Dialog>;
}
