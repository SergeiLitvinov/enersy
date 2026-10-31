import { parameterUnitLabel, type ParameterUnitDeclaration } from '../../../api/parameter-unit-declaration';
import React, { useState } from 'react';
import { EditorComponent } from '../editor-utils';
import { SwitchStateControl } from './SwitchStateControl';
import { LoadProfileForm } from './LoadProfileForm';
import { loadProfileKeys } from '../../../domain/load-profile';
import { ParameterUnitDialog } from './ParameterUnitDialog';

interface ComponentParamsProps {
  component: EditorComponent;
  onSave: (k: string, v: string) => void | Promise<void>;
  onSaveParams?: (values: Readonly<Record<string, string>>, declaration?: ParameterUnitDeclaration) => Promise<void>;
  parameterResets?: Readonly<Record<string, number>>;
}

function ParameterInput({ id, confirmed, boolean, placeholder, unit, onSave }: {
  id: string; confirmed: string; boolean: boolean; placeholder: string; unit: string; onSave: (value: string) => void;
}) {
  const [input, setInput] = useState({ confirmed, value: confirmed, unit, currentUnit: unit, conflicted: false });
  // Adopt new confirmed values only in clean fields. An acknowledgement of an
  // earlier write must not erase text entered while that request was pending.
  if (input.confirmed !== confirmed || input.currentUnit !== unit) {
    const clean = input.value === input.confirmed && !input.conflicted;
    setInput({ confirmed, value: clean ? confirmed : input.value, unit: clean ? unit : input.unit, currentUnit: unit,
      conflicted: input.conflicted || (!clean && input.unit !== unit) });
  }
  const change = (value: string) => setInput({ ...input, confirmed, value });
  return <div className="parameter-value-input">
    {boolean ? <input id={id} type="checkbox" checked={input.value === 'true'} disabled={input.conflicted}
      onChange={event => { const value = event.target.checked ? 'true' : 'false'; change(value); if (!input.conflicted) onSave(value); }} />
    : <input id={id} type="text" value={input.value} placeholder={placeholder} aria-describedby={input.conflicted ? `${id}-unit-conflict` : undefined}
      onChange={event => change(event.target.value)} onBlur={event => { if (!input.conflicted && event.target.value !== confirmed) onSave(event.target.value); }} />}
    {input.conflicted && <span id={`${id}-unit-conflict`} role="alert">Единица изменилась. Ввод не сохранён. <button type="button" className="tool-btn" onClick={() => setInput({ confirmed, value: confirmed, unit, currentUnit: unit, conflicted: false })}>Вернуть сохранённое значение</button></span>}
  </div>;
}

export const ComponentParams: React.FC<ComponentParamsProps> = ({ component, onSave, onSaveParams, parameterResets }) => {
  const [unitDialog, setUnitDialog] = useState(false);
  const switchKind = component.type === 'breaker' || component.type === 'disconnector' || component.type === 'grounding_switch' ? component.type : undefined;
  const loadForm = component.type === 'load' && onSaveParams;
  const templates = component.paramTemplate ?? [];
  const fields = component.type === 'transformer' && !templates.some(p => p.key === 'phase_shift_deg')
    ? [...templates, { key: 'phase_shift_deg', name: 'Фазосдвиг НН относительно ВН', type: 'number', unit: '°', default: 'Не задано' }]
    : templates;
  return (
    <div className="component-params">
      <h3 className="param-title">{component.name}</h3>
      {onSaveParams && <button type="button" className="tool-btn" disabled={!component.paramTemplate?.length && !Object.keys(component.params).length} onClick={() => setUnitDialog(true)}>Задать значение и единицу</button>}
      {unitDialog && onSaveParams && <ParameterUnitDialog component={{ ...component, paramTemplate: fields }} onClose={() => setUnitDialog(false)}
        onSave={(key, value, unit) => onSaveParams({ [key]: value }, { formatVersion: 1, units: { [key]: unit } })} />}
      {component.projectPassportVersionId != null && <p className="catalog-hint">Паспорт проекта · версия #{component.projectPassportVersionId}. Редактируется копия параметров экземпляра; обновление паспорта её не меняет.</p>}
      {component.equipmentModelId != null && <p className="catalog-hint">Паспорт каталога #{component.equipmentModelId} · редактируется копия параметров экземпляра</p>}
      <p className="catalog-hint">Объект #{component.id} · {loadForm ? 'Профиль нагрузки применяется кнопкой; прочие поля сохраняются при выходе из поля.' : 'Текстовые значения сохраняются при выходе из поля.'} Подсказка не означает заданный параметр.</p>
      {switchKind && <SwitchStateControl kind={switchKind} params={component.params} onSave={onSave} />}
      {loadForm && <LoadProfileForm componentId={component.id} params={component.params} onSave={loadForm} parameterResets={parameterResets} unitDeclaration={component.declaredParameterUnits} />}
      {component.type === 'transformer' && <p className="catalog-hint">φ: от −180° до 180°; положительный угол — опережение НН на холостом ходу. Без значения ядро принимает 0° с допущением. Группа соединения и нейтраль этой моделью не определяются.</p>}
      {fields.filter(p => !(switchKind && p.key === 'status') && !(loadForm && loadProfileKeys.some(key => key === p.key))).map(p => (
        <div key={p.key} className="param-item">
          <label htmlFor={`param-${component.id}-${p.key}`}>{p.name}</label>
          <ParameterInput key={`${p.key}:${parameterResets?.[p.key] ?? 0}`} id={`param-${component.id}-${p.key}`}
            confirmed={component.params[p.key] ?? ''} boolean={p.type === 'boolean'} placeholder={p.default || 'Не задано'}
            unit={parameterUnitLabel(component.declaredParameterUnits, p.key, '')}
            onSave={value => onSave(p.key, value)} />
          <span className="param-unit">{parameterUnitLabel(component.declaredParameterUnits, p.key, p.unit)}</span>
        </div>
      ))}
      {!component.paramTemplate?.length && <p className="placeholder-text">Загрузка...</p>}
    </div>
  );
};
