import React, { useEffect, useState } from 'react';
import { getComputeCapabilities, ComputeCapability } from '../../../api/ees-api';
import { Icon } from '../../ui/Icon';
import { Dialog } from '../../ui/Dialog';
import { backendLabel, isComputeBackendId, type ComputeBackendId } from '../../../api/compute-backends';
import { isCalculationBudget } from '../../../api/calculation-execution';
import { AC_INPUT_UNIT_PROFILE, SCALED_AC_INPUT_UNIT_PROFILE, BASED_AC_INPUT_UNIT_PROFILE, type InputUnitContract } from '../../../api/input-unit-contract';
import './CanvasToolbar.css';
interface CanvasToolbarProps {
  unitProfile: InputUnitContract['profile']; onUnitProfileChange: (profile: InputUnitContract['profile']) => void;
  onShowLimits?:()=>void; limitCount?:number; limitsStale?:boolean;
  maxTimeMs: number; onMaxTimeChange: (value: number) => void;
  computeBackend: ComputeBackendId; computeBackends: ComputeBackendId[]; backendMessage: string;
  onBackendChange: (backend: ComputeBackendId) => void; onBackendReload: () => void;
  currentSchemeId?: number; selectedComponent: number | null; selectedConnection: number | null; zoomPercent: number;
  calcMethod: string; modelGroup: string; isCalculating: boolean; hasResult: boolean;
  calculationBlockedReason?: string;
  onCalcMethodChange: (method: string) => void; onModelGroupChange: (group: string) => void; onCalculate: () => void; onShowResult: () => void;
  onDeleteComponent: () => void; onDeleteConnection: () => void; onZoomIn: () => void; onZoomOut: () => void; onResetView: () => void;
}
const GROUP_LABELS: Record<string, string> = { 'three-phase': 'Симметричный AC-режим', 'phase-coordinates': 'Фазные координаты', 'symmetrical-components': 'Симметричные составляющие' };
const METHOD_LABELS: Record<string, string> = { 'newton-raphson': 'Ньютон–Рафсон', direct: 'Прямой метод' };
export const CanvasToolbar: React.FC<CanvasToolbarProps> = ({ unitProfile, onUnitProfileChange, onShowLimits, limitCount=0, limitsStale=false, maxTimeMs, onMaxTimeChange, computeBackend, computeBackends, backendMessage, onBackendChange, onBackendReload, currentSchemeId, selectedComponent, selectedConnection, zoomPercent, calcMethod, modelGroup, isCalculating, hasResult, calculationBlockedReason, onCalcMethodChange, onModelGroupChange, onCalculate, onShowResult, onDeleteComponent, onDeleteConnection, onZoomIn, onZoomOut, onResetView }) => {
  const [capabilities, setCapabilities] = useState<ComputeCapability[]>([]);
  const [showCapabilities, setShowCapabilities] = useState(false);
  const [showUnitHelp, setShowUnitHelp] = useState(false);
  const [message, setMessage] = useState('Проверка возможностей…'); const [retry, setRetry] = useState(0);
  useEffect(() => { const controller = new AbortController(); setCapabilities([]); setMessage('Проверка возможностей…');
    getComputeCapabilities(controller.signal).then(entries => { if (!controller.signal.aborted) { setCapabilities(entries); setMessage(''); } }).catch((error: unknown) => { if (!controller.signal.aborted) { setCapabilities([]); setMessage(error instanceof Error ? error.message : 'Сервис недоступен'); } });
    return () => controller.abort();
  }, [retry]);
  const selected = capabilities.find(c => c.model_group === modelGroup && c.method === calcMethod);
  const available = Boolean(selected && selected.status !== 'unsupported' && computeBackends.includes(computeBackend) && isCalculationBudget(maxTimeMs) && !limitsStale);
  const groups = [...new Set(capabilities.map(c => c.model_group))]; const methods = capabilities.filter(c => c.model_group === modelGroup);
  return <div className="toolbar" aria-label="Управление схемой и расчётом">
    <div className="toolbar-calculation">
      {onShowLimits && <button className="tool-btn" onClick={onShowLimits} aria-label="Границы напряжения" disabled={!currentSchemeId||isCalculating}>Границы · {limitCount}</button>}
      {limitsStale && <span role="alert">Схема изменена: пересмотрите границы напряжения.</span>}
      <select aria-label="Вычислительный движок" className="method-select" value={computeBackend} disabled={isCalculating || !computeBackends.length} onChange={e => { if (isComputeBackendId(e.target.value)) onBackendChange(e.target.value); }}>
        {!computeBackends.includes(computeBackend) && <option value={computeBackend} disabled>{backendLabel(computeBackend)} · недоступен</option>}
        {computeBackends.map(id => <option key={id} value={id}>{backendLabel(id)}</option>)}
      </select>
      <button className="icon-button" aria-label="Обновить список движков" title={backendMessage || 'Обновить список движков'} onClick={onBackendReload} disabled={isCalculating}><Icon name="reset" /></button>
      {backendMessage && <span role="status" className="capability-badge">{backendMessage}</span>}
      <label className="execution-budget">Лимит, мс <input aria-label="Бюджет времени, мс" className="method-select" type="number" min="1" max="20000" step="1" value={Number.isNaN(maxTimeMs) ? '' : maxTimeMs} disabled={isCalculating} onChange={e => onMaxTimeChange(e.currentTarget.valueAsNumber)} /></label>
      <select aria-label="Профиль единиц расчёта" className="method-select unit-profile-select" value={unitProfile} disabled={isCalculating} onChange={e => {
        const value = e.target.value;
        if (value === AC_INPUT_UNIT_PROFILE || value === SCALED_AC_INPUT_UNIT_PROFILE || value === BASED_AC_INPUT_UNIT_PROFILE) onUnitProfileChange(value);
      }}>
        <option value={AC_INPUT_UNIT_PROFILE}>Без пересчёта · AC v1</option>
        <option value={SCALED_AC_INPUT_UNIT_PROFILE}>Масштабы SI · AC v2</option>
        <option value={BASED_AC_INPUT_UNIT_PROFILE}>SI и p.u. · AC v3</option>
      </select>
      <button className="icon-button" aria-label="Пояснение профиля единиц" title="Единицы и исходные базисы" onClick={() => setShowUnitHelp(true)}><Icon name="book" /></button>
      <button className="tool-btn primary calculate-button" onClick={onCalculate} disabled={!currentSchemeId || !available || isCalculating || Boolean(calculationBlockedReason)} title={calculationBlockedReason || message || selected?.reasons.join('; ')}><Icon name="play" />{isCalculating ? 'Расчёт…' : 'Рассчитать'}</button>
      <select aria-label="Группа расчётной модели" className="group-select" value={modelGroup} disabled={isCalculating || !groups.length} onChange={e => onModelGroupChange(e.target.value)}>{(groups.length ? groups : [modelGroup]).map(group => <option key={group} value={group} disabled={!capabilities.some(c => c.model_group === group && c.status !== 'unsupported')}>{GROUP_LABELS[group] || group}</option>)}</select>
      <select aria-label="Метод расчёта" className="method-select" value={calcMethod} disabled={isCalculating || !methods.length} onChange={e => onCalcMethodChange(e.target.value)}>{(methods.length ? methods : [{ method: calcMethod, status: 'unsupported' }]).map(method => <option key={method.method} value={method.method} disabled={method.status === 'unsupported'}>{METHOD_LABELS[method.method] || method.method}</option>)}</select>
      <span className="capability-badge" role="status" title={selected?.reasons.join('; ')}>{message || (selected?.status === 'experimental' ? 'Экспериментальный' : selected?.status === 'validated' ? 'Проверен' : selected?.status === 'deprecated' ? 'Устаревает' : 'Не поддержан')}</span>
      <button className="icon-button" aria-label="Возможности и ограничения расчёта" title="Возможности и ограничения" onClick={() => setShowCapabilities(true)}><Icon name="book" /></button>
      {message && <button className="icon-button" aria-label="Повторить проверку возможностей" onClick={() => setRetry(n => n + 1)}><Icon name="reset" /></button>}
    </div>
    {showUnitHelp && <Dialog title="Единицы расчёта и исходные базисы" onClose={() => setShowUnitHelp(false)}>
      <p>Выбор относится к следующему расчёту сохранённой схемы. Изменение профиля не пересчитывает и не изменяет параметры оборудования.</p>
      <p><strong>AC v1 · без пересчёта.</strong> Полная проверка обозначений. Где нет явной единицы экземпляра, используются обозначения текущего шаблона. Это не подтверждает историческое происхождение единиц.</p>
      <p><strong>AC v2 · масштабы SI.</strong> Только явно сохранённые единицы экземпляра. Поддержанные масштабы, например В → кВ или Вт → МВт, пересчитываются во входе решателя. p.u. не поддерживается.</p>
      <p><strong>AC v3 · SI и p.u.</strong> Требует явные единицы и собственный исходный базис каждого p.u.-параметра: Sб в трёхфазных МВА, Uб в линейных RMS кВ. Неполный базис или неподдержанная величина блокируют расчёт. Базис исследования не заполняет исходные базисы.</p>
      <p>В быстром расчёте мощность базиса определяется настройкой установки (по умолчанию 100 МВА), а напряжение — наибольшим нормализованным номинальным напряжением оборудования. Для явного выбора базиса решателя сохраните исследование. Фазное/линейное напряжение и RMS/амплитуда автоматически не заменяются.</p>
    </Dialog>}
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
