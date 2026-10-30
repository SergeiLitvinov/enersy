import { parameterUnitLabel } from '../../../api/parameter-unit-declaration';
import React, { useState } from 'react';
import { EditorComponent } from '../editor-utils';
import { SwitchStateControl } from './SwitchStateControl';
import { LoadProfileForm } from './LoadProfileForm';
import { loadProfileKeys } from '../../../domain/load-profile';

interface ComponentParamsProps {
  component: EditorComponent;
  onSave: (k: string, v: string) => void | Promise<void>;
  onSaveParams?: (values: Readonly<Record<string, string>>) => Promise<void>;
  parameterResets?: Readonly<Record<string, number>>;
}

function ParameterInput({ id, confirmed, boolean, placeholder, onSave }: {
  id: string; confirmed: string; boolean: boolean; placeholder: string; onSave: (value: string) => void;
}) {
  const [input, setInput] = useState({ confirmed, value: confirmed });
  // Adopt new confirmed values only in clean fields. An acknowledgement of an
  // earlier write must not erase text entered while that request was pending.
  if (input.confirmed !== confirmed) {
    setInput({ confirmed, value: input.value === input.confirmed ? confirmed : input.value });
  }
  const change = (value: string) => setInput({ confirmed, value });
  return boolean ? (
    <input id={id} type="checkbox" checked={input.value === 'true'}
      onChange={event => { const value = event.target.checked ? 'true' : 'false'; change(value); onSave(value); }} />
  ) : (
    <input id={id} type="text" value={input.value} placeholder={placeholder}
      onChange={event => change(event.target.value)} onBlur={event => { if (event.target.value !== confirmed) onSave(event.target.value); }} />
  );
}

export const ComponentParams: React.FC<ComponentParamsProps> = ({ component, onSave, onSaveParams, parameterResets }) => {
  const switchKind = component.type === 'breaker' || component.type === 'disconnector' || component.type === 'grounding_switch' ? component.type : undefined;
  const loadForm = component.type === 'load' && onSaveParams;
  const templates = component.paramTemplate ?? [];
  const fields = component.type === 'transformer' && !templates.some(p => p.key === 'phase_shift_deg')
    ? [...templates, { key: 'phase_shift_deg', name: 'Фазосдвиг НН относительно ВН', type: 'number', unit: '°', default: 'Не задано' }]
    : templates;
  return (
    <div className="component-params">
      <h3 className="param-title">{component.name}</h3>
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
            onSave={value => onSave(p.key, value)} />
          <span className="param-unit">{parameterUnitLabel(component.declaredParameterUnits, p.key, p.unit)}</span>
        </div>
      ))}
      {!component.paramTemplate?.length && <p className="placeholder-text">Загрузка...</p>}
    </div>
  );
};
