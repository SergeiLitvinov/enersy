import React, { useState } from 'react';
import { EditorComponent } from '../editor-utils';

interface ComponentParamsProps {
  component: EditorComponent;
  onSave: (k: string, v: string) => void;
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

export const ComponentParams: React.FC<ComponentParamsProps> = ({ component, onSave, parameterResets }) => {
  return (
    <div className="component-params">
      <h3 className="param-title">{component.name}</h3>
      {component.equipmentModelId != null && <p className="catalog-hint">Паспорт каталога #{component.equipmentModelId} · редактируется копия параметров экземпляра</p>}
      <p className="catalog-hint">Объект #{component.id} · значения сохраняются при выходе из поля. Подсказка не означает заданный параметр.</p>
      {component.paramTemplate?.map(p => (
        <div key={p.key} className="param-item">
          <label htmlFor={`param-${component.id}-${p.key}`}>{p.name}</label>
          <ParameterInput key={`${p.key}:${parameterResets?.[p.key] ?? 0}`} id={`param-${component.id}-${p.key}`}
            confirmed={component.params[p.key] ?? ''} boolean={p.type === 'boolean'} placeholder={p.default || 'Не задано'}
            onSave={value => onSave(p.key, value)} />
          <span className="param-unit">{p.unit}</span>
        </div>
      ))}
      {!component.paramTemplate?.length && <p className="placeholder-text">Загрузка...</p>}
    </div>
  );
};
