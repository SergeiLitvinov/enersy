import { useMemo } from 'react';
import { describeEndpoint, equipmentConnections, equipmentTerminals, indexEquipment, terminalForPort, type EndpointDescription, type EquipmentReference, type ConnectionReference } from '../../../domain/equipment-terminals';
interface Props {
  components: readonly EquipmentReference[];
  connections: readonly ConnectionReference[];
  onSelectComponent?: (id: number) => void;
  onSelectConnection?: (id: number) => void;
}
function Endpoint({ endpoint, onSelect }: { endpoint: EndpointDescription; onSelect?: (id: number) => void }) {
  if (endpoint.status === 'unresolved') return <span className="terminal-unresolved">Объект #{endpoint.equipmentId} · порт {endpoint.port || '(пустой)'}<small>{endpoint.reason}</small></span>;
  return <span>{onSelect ? <button className="terminal-link" onClick={() => onSelect(endpoint.equipment.id)}>{endpoint.equipment.name} #{endpoint.equipment.id}</button> : `${endpoint.equipment.name} #${endpoint.equipment.id}`}<small>Терминал {endpoint.terminal} · порт {endpoint.port}</small></span>;
}
export function TerminalInspector({ component, components, connections, onSelectComponent, onSelectConnection }: Props & { component: EquipmentReference }) {
  const index = useMemo(() => indexEquipment(components), [components]);
  const terminals = equipmentTerminals(component.type);
  const incident = equipmentConnections(component.id, connections);
  const unknown = incident.filter(item => terminalForPort(component.type, item.localPort) === undefined);
  return <section className="terminal-inspector" aria-label="Терминалы объекта">
    <h3>Терминалы и связи</h3>
    <p className="terminal-note">Внешние точки текущего AC-контракта. Порты одного терминала — графические алиасы одной точки. Это не схема замещения.</p>
    {!terminals ? <p role="status">Для типа «{component.type}» терминальный контракт неизвестен.</p> : terminals.map(terminal => {
      const attached = incident.filter(item => terminalForPort(component.type, item.localPort) === terminal.ordinal);
      return <div className="terminal-card" key={terminal.ordinal}><h4>Терминал {terminal.ordinal}</h4><p className="terminal-note">Порты: {terminal.aliases.join(', ')}</p>
        {!attached.length && <p className="terminal-note">Внешних связей нет</p>}
        {attached.map(item => <div className="terminal-edge" key={`${item.connection.id}:${item.localPort}`}>
          {onSelectConnection ? <button className="terminal-link" onClick={() => onSelectConnection(item.connection.id)}>Связь #{item.connection.id}</button> : <strong>Связь #{item.connection.id}</strong>}
          <small>Через порт {item.localPort}</small>
          <Endpoint endpoint={describeEndpoint(index, item.remoteId, item.remotePort)} onSelect={onSelectComponent} />
          {!!item.connection.validationErrors?.length && <p className="terminal-unresolved">Серверная диагностика: {item.connection.validationErrors.join(', ')}</p>}
        </div>)}
      </div>;
    })}
    {unknown.length > 0 && <div className="terminal-unresolved"><p>Связи с неизвестным локальным портом: {unknown.map(item => `#${item.connection.id} (${item.localPort || 'пустой'})`).join(', ')}. Терминал не подставлен.</p></div>}
    <p className="terminal-note">Состояние аппарата и электрические узлы определяет расчётный компилятор. Фазы, нейтраль и внутренние узлы здесь не раскрываются.</p>
  </section>;
}
export function ConnectionInspector({ connectionId, components, connections, onSelectComponent }: Props & { connectionId: number }) {
  const index = useMemo(() => indexEquipment(components), [components]);
  const connection = connections.find(item => item.id === connectionId);
  return <section className="terminal-inspector" aria-label="Свойства соединения"><h3>Соединение #{connectionId}</h3>
    {!connection ? <p role="status">Связь отсутствует в загруженной схеме.</p> : <>
      <div className="terminal-card"><h4>Первый конец</h4><Endpoint endpoint={describeEndpoint(index, connection.from, connection.fromPort)} onSelect={onSelectComponent} /></div>
      <div className="terminal-card"><h4>Второй конец</h4><Endpoint endpoint={describeEndpoint(index, connection.to, connection.toPort)} onSelect={onSelectComponent} /></div>
      {!!connection.validationErrors?.length && <p className="terminal-unresolved">Серверная диагностика: {connection.validationErrors.join(', ')}</p>}
      <p className="terminal-note">Порядок концов не задаёт направление тока или мощности. Координаты линии не определяют электрическую топологию.</p>
      <p className="terminal-note">Для удаления используйте кнопку соединения на панели инструментов.</p>
    </>}
  </section>;
}
