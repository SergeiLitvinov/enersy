import React from 'react';
import { EditorComponent } from '../editor-utils';
import { ComponentParams } from './ComponentParams';
import './PropertiesPanel.css';
import { Icon } from '../../ui/Icon';

interface PropertiesPanelProps {
  selectedComponent: EditorComponent | undefined;
  selectedConnection: number | null;
  currentSchemeId?: number;
  onSaveParam: (k: string, v: string) => void;
}

export const PropertiesPanel: React.FC<PropertiesPanelProps> = ({
  selectedComponent, selectedConnection, currentSchemeId, onSaveParam,
}) => {
  return (
    <aside className="properties-panel">
      <div className="panel-heading"><div><p className="eyebrow">Инспектор</p><h2>Свойства объекта</h2></div><Icon name="panel" /></div>
      {selectedComponent ? (
        <ComponentParams key={selectedComponent.id} component={selectedComponent} onSave={onSaveParam} />
      ) : selectedConnection ? (
        <div className="inspector-empty"><Icon name="link" /><h3>Соединение выбрано</h3><p>Для удаления используйте кнопку соединения на панели инструментов.</p></div>
      ) : (
        <div className="inspector-empty"><Icon name="box" /><h3>{currentSchemeId ? 'Выберите оборудование' : 'Начните со схемы'}</h3><p>{currentSchemeId ? 'Нажмите на объект, чтобы увидеть его параметры и единицы измерения.' : 'Создайте новую схему или откройте существующую в панели слева.'}</p></div>
      )}
    </aside>
  );
};
