import { useId } from 'react';
import type { ComponentParam } from '../../../api/ees-api';
import type { CreationParameterRow } from '../../../features/catalog/creation-parameters';

export function CreationParametersForm({ rows, template, disabled, onChange }: {
  rows: CreationParameterRow[]; template: ComponentParam[]; disabled: boolean;
  onChange: (rows: CreationParameterRow[]) => void;
}) {
  const listId = useId();
  function update(id: number, field: 'key' | 'value' | 'unit', value: string) {
    onChange(rows.map(row => row.id === id ? { ...row, [field]: value } : row));
  }
  return <details className="creation-parameters">
    <summary>Параметры экземпляра{rows.length ? ` · ${rows.length}` : ''}</summary>
    <p>Задайте свои значения или замените отдельные параметры выбранного паспорта. Значение и единица сохраняются вместе; пересчёт не выполняется. Для безразмерной величины укажите 1.</p>
    <p className="passport-count">Паспорт остаётся неизменным. Смена источника или паспорта очищает этот список.</p>
    <datalist id={listId}>{template.map(item => <option key={item.key} value={item.key}>{item.name}</option>)}</datalist>
    <div className="creation-parameter-rows">{rows.map((row, index) => {
      const hint = template.find(item => item.key === row.key);
      return <fieldset key={row.id} disabled={disabled} className="creation-parameter-row">
        <legend>Параметр {index + 1}{hint ? ` · ${hint.name}` : ''}</legend>
        <label className="passport-field">Ключ<input list={listId} value={row.key} maxLength={50} onChange={event => update(row.id, 'key', event.target.value)} placeholder="Например, voltage_nom" /></label>
        <label className="passport-field">Значение<input value={row.value} onChange={event => update(row.id, 'value', event.target.value)} placeholder="Не задано" /></label>
        <label className="passport-field">Единица<input value={row.unit} maxLength={64} onChange={event => update(row.id, 'unit', event.target.value)} placeholder="Укажите явно" /></label>
        <button className="tool-btn" type="button" aria-label={`Удалить параметр ${index + 1}`} onClick={() => onChange(rows.filter(item => item.id !== row.id))}>Удалить</button>
        {hint?.unit && <small className="creation-parameter-hint">Справочно, в шаблоне типа: {hint.unit}. Единица исходных данных этим не подтверждена.</small>}
      </fieldset>;
    })}</div>
    <button className="tool-btn" type="button" disabled={disabled || rows.length >= 256} onClick={() => onChange([...rows, { id: Math.max(0, ...rows.map(row => row.id)) + 1, key: '', value: '', unit: '' }])}>Добавить параметр</button>
  </details>;
}
