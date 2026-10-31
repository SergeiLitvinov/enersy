import React, { useState } from 'react';
import { EditorComponent } from '../editor-utils';
import { ComponentParams } from './ComponentParams';
import { ModelInspector } from './ModelInspector';
import { TerminalInspector, ConnectionInspector } from './TerminalInspector';
import type { EquipmentReference, ConnectionReference } from '../../../domain/equipment-terminals';
import './PropertiesPanel.css';
import { Icon } from '../../ui/Icon';
import type { ParameterUnitDeclaration } from '../../../api/parameter-unit-declaration';

interface PropertiesPanelProps {
  selectedComponent: EditorComponent | undefined;
  selectedConnection: number | null;
  components?: readonly EquipmentReference[];
  connections?: readonly ConnectionReference[];
  onSelectComponent?: (id: number) => void;
  onSelectConnection?: (id: number) => void;
  currentSchemeId?: number;
  onSaveParam: (k: string, v: string) => void | Promise<void>;
  onSaveParams?: (values: Readonly<Record<string, string>>, declaration?: ParameterUnitDeclaration) => Promise<void>;
  parameterResets?: Readonly<Record<string, number>>;
}

export const PropertiesPanel = React.memo(function PropertiesPanel({
  selectedComponent, selectedConnection, currentSchemeId, onSaveParam, onSaveParams, parameterResets, components = [], connections = [], onSelectComponent, onSelectConnection,
}: PropertiesPanelProps) {
  const [section, setSection] = useState<'parameters' | 'terminals' | 'model'>('parameters');
  return (
    <aside className="properties-panel">
      <div className="panel-heading"><div><p className="eyebrow">Инспектор</p><h2>Свойства объекта</h2></div><Icon name="panel" /></div>
      {selectedComponent ? (
        <>
          <div className="inspector-sections" role="group" aria-label="Раздел свойств">
            <button className="tool-btn" aria-pressed={section === 'parameters'} onClick={() => setSection('parameters')}>Параметры</button>
            <button className="tool-btn" aria-pressed={section === 'terminals'} onClick={() => setSection('terminals')}>Терминалы и связи</button>
            <button className="tool-btn" aria-pressed={section === 'model'} onClick={() => setSection('model')}>Модель</button>
          </div>
          <div hidden={section !== 'parameters'}><ComponentParams key={selectedComponent.id} component={selectedComponent} onSave={onSaveParam} onSaveParams={onSaveParams} parameterResets={parameterResets} /></div>
          <div hidden={section !== 'terminals'}><h3 className="param-title">{selectedComponent.name} #{selectedComponent.id}</h3><TerminalInspector component={selectedComponent} components={components} connections={connections} onSelectComponent={onSelectComponent} onSelectConnection={onSelectConnection} /></div>
          <div hidden={section !== 'model'}><ModelInspector equipmentType={selectedComponent.type} params={selectedComponent.params} active={section === 'model'} /></div>
        </>
      ) : selectedConnection ? (
        <ConnectionInspector connectionId={selectedConnection} components={components} connections={connections} onSelectComponent={onSelectComponent} />
      ) : (
        <div className="inspector-empty"><Icon name="box" /><h3>{currentSchemeId ? 'Выберите оборудование' : 'Начните со схемы'}</h3><p>{currentSchemeId ? 'Нажмите на объект, чтобы увидеть его параметры и единицы измерения.' : 'Создайте новую схему или откройте существующую в панели слева.'}</p></div>
      )}
    </aside>
  );
});
