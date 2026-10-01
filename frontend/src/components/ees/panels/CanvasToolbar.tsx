import React, { useEffect, useState } from 'react';
import { getComputeCapabilities, ComputeCapability } from '../../../api/ees-api';
import { Icon } from '../../ui/Icon';
import { Dialog } from '../../ui/Dialog';
import './CanvasToolbar.css';
interface CanvasToolbarProps {
  currentSchemeId?: number; selectedComponent: number | null; selectedConnection: number | null; zoomPercent: number;
  calcMethod: string; modelGroup: string; isCalculating: boolean; hasResult: boolean;
  onCalcMethodChange: (method: string) => void; onModelGroupChange: (group: string) => void; onCalculate: () => void; onShowResult: () => void;
  onDeleteComponent: () => void; onDeleteConnection: () => void; onZoomIn: () => void; onZoomOut: () => void; onResetView: () => void;
}
const GROUP_LABELS: Record<string, string> = { 'three-phase': 'Симметричный AC-режим', 'phase-coordinates': 'Фазные координаты', 'symmetrical-components': 'Симметричные составляющие' };
const METHOD_LABELS: Record<string, string> = { 'newton-raphson': 'Ньютон–Рафсон', direct: 'Прямой метод' };
export const CanvasToolbar: React.FC<CanvasToolbarProps> = ({ currentSchemeId, selectedComponent, selectedConnection, zoomPercent, calcMethod, modelGroup, isCalculating, hasResult, onCalcMethodChange, onModelGroupChange, onCalculate, onShowResult, onDeleteComponent, onDeleteConnection, onZoomIn, onZoomOut, onResetView }) => {
  const [capabilities, setCapabilities] = useState<ComputeCapability[]>([]);
  const [showCapabilities, setShowCapabilities] = useState(false);
  const [message, setMessage] = useState('Проверка возможностей…'); const [retry, setRetry] = useState(0);
  useEffect(() => { const controller = new AbortController(); setCapabilities([]); setMessage('Проверка возможностей…');
    getComputeCapabilities(controller.signal).then(entries => { if (!controller.signal.aborted) { setCapabilities(entries); setMessage(''); } }).catch((error: unknown) => { if (!controller.signal.aborted) { setCapabilities([]); setMessage(error instanceof Error ? error.message : 'Сервис недоступен'); } });
    return () => controller.abort();
  }, [retry]);
  const selected = capabilities.find(c => c.model_group === modelGroup && c.method === calcMethod);
  const available = Boolean(selected && selected.status !== 'unsupported');
  const groups = [...new Set(capabilities.map(c => c.model_group))]; const methods = capabilities.filter(c => c.model_group === modelGroup);
  return <div className="toolbar" aria-label="Управление схемой и расчётом">
    <div className="toolbar-calculation">
      <button className="tool-btn primary calculate-button" onClick={onCalculate} disabled={!currentSchemeId || !available || isCalculating} title={message || selected?.reasons.join('; ')}><Icon name="play" />{isCalculating ? 'Расчёт…' : 'Рассчитать'}</button>
      <select aria-label="Группа расчётной модели" className="group-select" value={modelGroup} disabled={isCalculating || !groups.length} onChange={e => onModelGroupChange(e.target.value)}>{(groups.length ? groups : [modelGroup]).map(group => <option key={group} value={group} disabled={!capabilities.some(c => c.model_group === group && c.status !== 'unsupported')}>{GROUP_LABELS[group] || group}</option>)}</select>
      <select aria-label="Метод расчёта" className="method-select" value={calcMethod} disabled={isCalculating || !methods.length} onChange={e => onCalcMethodChange(e.target.value)}>{(methods.length ? methods : [{ method: calcMethod, status: 'unsupported' }]).map(method => <option key={method.method} value={method.method} disabled={method.status === 'unsupported'}>{METHOD_LABELS[method.method] || method.method}</option>)}</select>
      <span className="capability-badge" role="status" title={selected?.reasons.join('; ')}>{message || (selected?.status === 'experimental' ? 'Экспериментальный' : selected?.status === 'validated' ? 'Проверен' : selected?.status === 'deprecated' ? 'Устаревает' : 'Не поддержан')}</span>
      <button className="icon-button" aria-label="Возможности и ограничения расчёта" title="Возможности и ограничения" onClick={() => setShowCapabilities(true)}><Icon name="book" /></button>
      {message && <button className="icon-button" aria-label="Повторить проверку возможностей" onClick={() => setRetry(n => n + 1)}><Icon name="reset" /></button>}
    </div>
    <div className="toolbar-tools">
      <button className="icon-button" onClick={onShowResult} disabled={!hasResult} aria-label="Результаты последнего расчёта" title="Результаты"><Icon name="chart" /></button>
      <span className="divider" />
      <button className="icon-button danger" onClick={onDeleteComponent} disabled={!selectedComponent} aria-label="Удалить выбранный компонент" title="Удалить компонент"><Icon name="trash" /></button>
      <button className="icon-button" onClick={onDeleteConnection} disabled={!selectedConnection} aria-label="Удалить выбранное соединение" title="Удалить соединение"><Icon name="link" /></button>
      <span className="divider" />
      <button className="icon-button" onClick={onZoomOut} aria-label="Уменьшить масштаб"><Icon name="minus" /></button><span className="zoom-value">{zoomPercent}%</span><button className="icon-button" onClick={onZoomIn} aria-label="Увеличить масштаб"><Icon name="plus" /></button><button className="icon-button" onClick={onResetView} aria-label="Вписать схему" title="Вписать схему"><Icon name="reset" /></button>
    </div>
    {showCapabilities && <Dialog title="Возможности расчёта" onClose={() => setShowCapabilities(false)}>
      <p className="dialog-intro">Статусы и причины получены из вычислительного сервиса. Наличие оборудования в каталоге не означает поддержку его физической модели.</p>
      {message && <p role="status">{message}</p>}
      <div className="capability-list">{capabilities.map(entry => <article className="capability-entry" key={`${entry.model_group}/${entry.method}`}>
        <h3>{GROUP_LABELS[entry.model_group] || entry.model_group} · {METHOD_LABELS[entry.method] || entry.method}</h3>
        <span className="capability-badge">{{ unsupported: 'Не поддержан', experimental: 'Экспериментальный', validated: 'Проверен', deprecated: 'Устаревает' }[entry.status]}</span>
        <p>{entry.summary}</p><ul>{entry.reasons.map((reason, index) => <li key={index}>{reason}</li>)}</ul>
      </article>)}</div>
    </Dialog>}
  </div>;
};
