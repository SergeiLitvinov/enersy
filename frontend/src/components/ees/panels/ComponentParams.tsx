import React, { useState } from 'react';
import { EditorComponent } from '../editor-utils';

interface ComponentParamsProps {
  component: EditorComponent;
  onSave: (k: string, v: string) => void;
}

export const ComponentParams: React.FC<ComponentParamsProps> = ({ component, onSave }) => {
  const [params, setParams] = useState<Record<string, string>>(component.params || {});
  const handleChange = (key: string, value: string) => {
    setParams(p => ({ ...p, [key]: value }));
  };
  return (
    <div className="component-params">
      <h3 className="param-title">{component.name}</h3>
      {component.equipmentModelId != null && <p className="catalog-hint">Паспорт каталога #{component.equipmentModelId} · редактируется копия параметров экземпляра</p>}
      <p className="catalog-hint">Объект #{component.id} · значения сохраняются при выходе из поля. Подсказка не означает заданный параметр.</p>
      {component.paramTemplate?.map(p => (
        <div key={p.key} className="param-item">
          <label htmlFor={`param-${component.id}-${p.key}`}>{p.name}</label>
          {p.type === 'boolean' ? (
            <input id={`param-${component.id}-${p.key}`} type="checkbox" checked={params[p.key] === 'true'}
              onChange={e => { const value = e.target.checked ? 'true' : 'false'; handleChange(p.key, value); onSave(p.key, value); }} />
          ) : (
            <input id={`param-${component.id}-${p.key}`} type="text" value={params[p.key] ?? ''} placeholder={p.default || 'Не задано'}
              onChange={e => handleChange(p.key, e.target.value)} onBlur={e => { if (e.target.value !== (component.params[p.key] ?? '')) onSave(p.key, e.target.value); }} />
          )}
          <span className="param-unit">{p.unit}</span>
        </div>
      ))}
      {!component.paramTemplate?.length && <p className="placeholder-text">Загрузка...</p>}
    </div>
  );
};
