import React, { useState, useCallback, useRef, useEffect } from 'react';
import { ComponentSVG, ComponentLibraryItem } from './svg-components';
import { EditorComponent, EditorConnection, getCompSize, getPorts, NATIVE_SIZES } from './editor-utils';
import { connectionPoints } from './editor-geometry';
import { useSchemeData } from './hooks/useSchemeData';
import { useCanvasViewport } from './hooks/useCanvasViewport';
import { useCanvasInteraction } from './hooks/useCanvasInteraction';
import { useDragDrop } from './hooks/useDragDrop';
import { LibraryPanel } from './panels/LibraryPanel';
import { CanvasToolbar } from './panels/CanvasToolbar';
import { PropertiesPanel } from './panels/PropertiesPanel';
import { ResultsModal } from './panels/ResultsModal';
import { ModelSelectModal } from './panels/ModelSelectModal';
import { CalculationResult } from '../../api/ees-api';
import { Icon } from '../ui/Icon';
import { NewSchemeDialog } from './panels/NewSchemeDialog';
import { RecoveryDialog } from './panels/RecoveryDialog';
import { useNotify } from '../NotificationProvider';
import './SchemeEditor.css';
import './workspace.css';
import type { ComponentWrites } from './component-writes';

export const SchemeEditor: React.FC<{ schemeId?: number; writeQueue?: ComponentWrites }> = ({ schemeId, writeQueue }) => {
  const { notify } = useNotify();
  const containerRef = useRef<HTMLDivElement>(null);
  const svgRef = useRef<SVGSVGElement>(null);

  const [theme, setTheme] = useState(() => localStorage.getItem('enersy-theme') || 'light');
  useEffect(() => {
    document.documentElement.setAttribute('data-theme', theme);
    localStorage.setItem('enersy-theme', theme);
  }, [theme]);

  const {
    components, setComponents, connections,
    library, schemes, currentSchemeId, setCurrentSchemeId,
    handleCreateScheme, handleDeleteScheme,
    addComponent, deleteSelectedComponent, deleteConnection,
    handleCalculate, updateComponentPosition, rotateComponent, saveComponentParam, addConnection,
    isCalculating, calculationError, loadedSchemeId, captureView, failedDrafts, resolveComponentDraft, resolveComponentDeletion, parameterResets,
  } = useSchemeData(schemeId, writeQueue);
  const [reviewComponent, setReviewComponent] = useState<number | null>(null);
  useEffect(() => { setReviewComponent(null); }, [currentSchemeId]);
  const reviewedDraft = failedDrafts.find(draft => draft.componentId === reviewComponent);
  useEffect(() => {
    // A resolved dialog must not reopen itself on a later independent conflict.
    if (reviewComponent !== null && !reviewedDraft) setReviewComponent(null);
  }, [reviewComponent, reviewedDraft]);
  const activeSchemeRef = useRef(currentSchemeId);
  activeSchemeRef.current = currentSchemeId;

  const {
    viewBox, setViewBox,
    screenToWorld, getWorldUnitsPerPixel, handleWheel, zoomIn, zoomOut, fitView,
  } = useCanvasViewport(containerRef);

  const [selectedComponent, setSelectedComponent] = useState<number | null>(null);
  const [selectedConnection, setSelectedConnection] = useState<number | null>(null);
  const [lastResult, setLastResult] = useState<CalculationResult | null>(null);
  const [resultsVisible, setResultsVisible] = useState(false);
  const [calcMethod, setCalcMethod] = useState<string>('newton-raphson');
  const [modelGroup, setModelGroup] = useState<string>('three-phase');
  const [pendingDrop, setPendingDrop] = useState<{ item: ComponentLibraryItem; wx: number; wy: number } | null>(null);
  const [createDialog, setCreateDialog] = useState(false);
  const [libraryVisible, setLibraryVisible] = useState(() => window.innerWidth > 1000);
  const [inspectorVisible, setInspectorVisible] = useState(() => window.innerWidth > 1200);
  const fittedSchemeRef = useRef<number | undefined>(undefined);
  useEffect(() => {
    if (currentSchemeId && loadedSchemeId === currentSchemeId && components.length && fittedSchemeRef.current !== currentSchemeId) {
      fitView(components);
      fittedSchemeRef.current = currentSchemeId;
    }
  }, [currentSchemeId, loadedSchemeId, components, fitView]);

  const handleModelGroupChange = useCallback((group: string) => {
    setModelGroup(group);
    setCalcMethod('newton-raphson');
  }, []);

  const onMoveEnd = useCallback((compId: number, x: number, y: number) => {
    if (currentSchemeId) void updateComponentPosition(compId, x, y);
  }, [currentSchemeId, updateComponentPosition]);

  const onConnectEnd = useCallback(async (schemeId: number, from: number, to: number, fromPort: string, toPort: string) => {
    await addConnection(schemeId, from, to, fromPort, toPort);
  }, [addConnection]);

  const handleRotateComponent = rotateComponent;

  const handleAddComponent = useCallback(async (item: ComponentLibraryItem, wx: number, wy: number) => {
    setPendingDrop({ item, wx, wy });
  }, []);

  const {
    dragMode, dragData, tempLine,
    handleMouseDown, handleMouseMove, handleMouseUp, resetInteraction,
  } = useCanvasInteraction({
    components, setComponents, connections, screenToWorld, getWorldUnitsPerPixel, setViewBox,
    viewBox, containerRef, currentSchemeId,
    onMoveEnd, onConnectEnd,
    onSelectComponent: setSelectedComponent,
    onSelectConnection: setSelectedConnection,
  });

  const { handleLibDragStart, handleCanvasDrop, handleDragOver } = useDragDrop({ addComponent: handleAddComponent, screenToWorld });

  useEffect(() => {
    resetInteraction();
    setPendingDrop(null);
    setSelectedComponent(null);
    setSelectedConnection(null);
    setLastResult(null);
    setResultsVisible(false);
  }, [currentSchemeId, resetInteraction]);

  const deleteSelectedComponentHandler = useCallback(async () => {
    if (!selectedComponent) return;
    const isCurrent = captureView();
    await deleteSelectedComponent(selectedComponent);
    if (isCurrent()) setSelectedComponent(null);
  }, [selectedComponent, deleteSelectedComponent, captureView]);

  const deleteConnectionHandler = useCallback(async () => {
    if (!selectedConnection) return;
    const isCurrent = captureView();
    await deleteConnection(selectedConnection);
    if (isCurrent()) setSelectedConnection(null);
  }, [selectedConnection, deleteConnection, captureView]);

  const handleCalculateClick = useCallback(async () => {
    const calculatedSchemeId = currentSchemeId;
    const result = await handleCalculate(modelGroup, calcMethod);
    if (!result || activeSchemeRef.current !== calculatedSchemeId) return;
    if (result.success) {
      setLastResult(result);
      setResultsVisible(true);
    } else {
      notify('Ошибка: ' + (result.error || '?'), 'error');
    }
  }, [handleCalculate, currentSchemeId, calcMethod, modelGroup, notify]);

  const closeModal = useCallback(() => setResultsVisible(false), []);

  const onSaveParam = useCallback((k: string, v: string) => {
    if (selectedComponent) {
      void saveComponentParam(selectedComponent, k, v);
    }
  }, [selectedComponent, saveComponentParam]);

  // Keyboard
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if ((e.target as HTMLElement).closest('input, textarea, select, [contenteditable], dialog[open]')) return;
      if (e.key === '/') { e.preventDefault(); setLibraryVisible(true); setInspectorVisible(false); requestAnimationFrame(() => document.querySelector<HTMLInputElement>('input[aria-label="Поиск оборудования"]')?.focus()); }
      if (e.key === 'Escape') { setSelectedComponent(null); setSelectedConnection(null); if (window.innerWidth <= 1000) { setLibraryVisible(false); setInspectorVisible(false); } }
      if (e.key === 'Delete' || e.key === 'Backspace') {
        if (selectedConnection) { deleteConnectionHandler(); e.preventDefault(); }
        else if (selectedComponent) { deleteSelectedComponentHandler(); e.preventDefault(); }
      }
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [selectedComponent, selectedConnection, deleteConnectionHandler, deleteSelectedComponentHandler]);

  const renderConnection = useCallback((conn: EditorConnection) => {
    const points = connectionPoints(conn, components);
    if (!points) return null;
    const sel = selectedConnection === conn.id;
    const middle = points[Math.floor(points.length / 2)];
    const midX = middle.x, midY = middle.y;
    const path = points.map((point, i) => `${i === 0 ? 'M' : 'L'} ${point.x} ${point.y}`).join(' ');
    return (
      <g key={conn.id}>
        <path d={path} className={sel ? 'connection-line-selected' : 'connection-line'} />
        {sel && (
          <g>
            <circle cx={midX} cy={midY} r="6" fill="var(--accent-red)" style={{ cursor: 'pointer' }}
              onClick={(e) => { e.stopPropagation(); deleteConnectionHandler(); }} />
            <text x={midX} y={midY} textAnchor="middle" dominantBaseline="central" fontSize="10" fill="#fff" pointerEvents="none">×</text>
          </g>
        )}
      </g>
    );
  }, [components, selectedConnection, deleteConnectionHandler]);

  const handleModelSelectConfirm = useCallback(async (equipmentModelId: number | null) => {
    if (!pendingDrop) return;
    const isCurrent = captureView();
    await addComponent(pendingDrop.item, pendingDrop.wx, pendingDrop.wy, equipmentModelId);
    if (isCurrent()) setPendingDrop(null);
  }, [pendingDrop, addComponent, captureView]);

  const renderComponent = useCallback((comp: EditorComponent) => {
    const SVGComp = ComponentSVG[comp.type];
    if (!SVGComp) return null;
    const s = getCompSize(comp.type);
    const sel = selectedComponent === comp.id;
    const rotation = comp.rotation || 0;
    const nativeW = NATIVE_SIZES[comp.type]?.w || 60;
    const nativeH = NATIVE_SIZES[comp.type]?.h || 60;
    const scaleX = s.w / nativeW;
    const scaleY = s.h / nativeH;
    const basePorts = getPorts(comp.type, nativeW, nativeH);
    return (
      <g key={comp.id}
        className={`canvas-component ${sel ? 'selected' : ''}`}
        transform={`translate(${comp.x}, ${comp.y}) rotate(${rotation}, ${s.w / 2}, ${s.h / 2}) scale(${scaleX}, ${scaleY})`}
      >
        <g className="component-svg" pointerEvents="none">
          <SVGComp />
        </g>
        <rect x={0} y={0} width={nativeW} height={nativeH} fill="transparent"
          role="button" tabIndex={0} aria-label={`Выбрать ${comp.name}`}
          onKeyDown={e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); setSelectedComponent(comp.id); setSelectedConnection(null); } }}
          style={{ pointerEvents: 'auto', cursor: dragMode === 'move' && dragData?.compId === comp.id ? 'grabbing' : 'grab' }}
        />
        {basePorts.map(p => {
          const isSrc = dragMode === 'connect' && dragData?.compId === comp.id && dragData?.portName === p.name;
          return (
            <circle key={`${comp.id}-${p.name}`} className="connection-point"
              cx={p.x} cy={p.y} r={4 / scaleX}
              fill={isSrc ? 'var(--accent-blue)' : undefined}
            />
          );
        })}
        {sel && (
          <g>
            <rect x={-2 / scaleX} y={-2 / scaleY} width={nativeW + 4 / scaleX} height={nativeH + 4 / scaleY}
              fill="none" stroke="var(--accent-blue)" strokeWidth={1.5 / scaleX} strokeDasharray={`${4 / scaleX} ${2 / scaleX}`} rx={2 / scaleX} />
            <circle cx={nativeW + 10 / scaleX} cy={-2 / scaleY} r={9 / scaleX} fill="var(--accent-blue)"
              role="button" tabIndex={0} aria-label={`Повернуть ${comp.name}`} onMouseDown={e => e.stopPropagation()}
              onKeyDown={e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); handleRotateComponent(comp.id); } }}
              style={{ cursor: 'pointer' }}
              onClick={(e) => { e.stopPropagation(); handleRotateComponent(comp.id); }}
            />
            <text x={nativeW + 10 / scaleX} y={-1 / scaleY} textAnchor="middle" dominantBaseline="central"
              fontSize={12 / scaleX} fill="#fff" pointerEvents="none">↻</text>
          </g>
        )}
        <text x={nativeW / 2} y={nativeH + 12 / scaleY} textAnchor="middle"
          fontSize={9 / scaleY} fill="var(--text-secondary)" pointerEvents="none">
          {comp.name}
        </text>
      </g>
    );
  }, [selectedComponent, dragMode, dragData, handleRotateComponent]);

  // Mouse move wrapper: delegates to interaction hook, handles pan
  const onMouseMove = useCallback((e: React.MouseEvent) => {
    handleMouseMove(e);
  }, [handleMouseMove]);

  const selectedComp = components.find(c => c.id === selectedComponent);
  const invalidConnections = connections.filter(c => c.validationErrors?.length);
  const connectionReasons: Record<string, string> = { scheme_mismatch: 'Объекты принадлежат разным схемам', unknown_port: 'Неизвестный порт', domain_mismatch: 'Несовместимые физические порты', identical_port: 'Порт соединён сам с собой' };
  const zoomPercent = Math.round((1600 / viewBox.w) * 100);
  const schemeName = schemes.find(s => s.id === currentSchemeId)?.name || 'Новая рабочая схема';

  return (
    <div className="scheme-editor-container" data-library={libraryVisible} data-inspector={inspectorVisible}>
      {libraryVisible && <LibraryPanel
        library={library}
        schemes={schemes}
        currentSchemeId={currentSchemeId}
        theme={theme}
        onThemeToggle={() => setTheme(t => t === 'dark' ? 'light' : 'dark')}
        onCreateScheme={() => setCreateDialog(true)}
        onSelectScheme={(id) => { setCurrentSchemeId(id); setSelectedComponent(null); setSelectedConnection(null); setLastResult(null); if (window.innerWidth <= 1000) setLibraryVisible(false); }}
        onDeleteScheme={handleDeleteScheme}
        onLibDragStart={handleLibDragStart}
        onAddItem={item => { setPendingDrop({ item, wx: viewBox.x + viewBox.w / 2, wy: viewBox.y + viewBox.h / 2 }); if (window.innerWidth <= 1000) setLibraryVisible(false); }}
      />}

      <main className="canvas-area">
        <div className="workspace-heading"><div className="workspace-title"><p className="eyebrow">Рабочая схема</p><h1>{currentSchemeId ? schemeName : 'Спроектируйте вашу сеть'}</h1></div><div className="panel-toggles"><button className="tool-btn" aria-pressed={libraryVisible} onClick={() => { setLibraryVisible(v => !v); if (window.innerWidth <= 1000) setInspectorVisible(false); }}><Icon name="box" />Каталог</button><button className="tool-btn" aria-pressed={inspectorVisible} onClick={() => { setInspectorVisible(v => !v); if (window.innerWidth <= 1000) setLibraryVisible(false); }}><Icon name="panel" />Инспектор</button></div></div>
        <CanvasToolbar
          currentSchemeId={currentSchemeId}
          selectedComponent={selectedComponent}
          selectedConnection={selectedConnection}
          zoomPercent={zoomPercent}
          calcMethod={calcMethod}
          modelGroup={modelGroup}
          isCalculating={isCalculating}
          hasResult={Boolean(lastResult)}
          onShowResult={() => setResultsVisible(true)}
          onCalcMethodChange={setCalcMethod}
          onModelGroupChange={handleModelGroupChange}
          onCalculate={handleCalculateClick}
          onDeleteComponent={deleteSelectedComponentHandler}
          onDeleteConnection={deleteConnectionHandler}
          onZoomIn={zoomIn}
          onZoomOut={zoomOut}
          onResetView={() => fitView(components)}
        />
        {calculationError && <div className="calculation-error" role="alert"><Icon name="alert" /><div><strong>Расчёт не выполнен</strong><p>{calculationError}</p></div></div>}
        {failedDrafts.length > 0 && <div className="calculation-error" role="alert"><Icon name="alert" /><div><strong>Сохранение требует проверки</strong><p>Неподтверждённые правки сохранены в журнале этой вкладки. Расчёт заблокирован до разрешения проблемы.</p><div className="connection-diagnostics-list">{failedDrafts.map(draft => <p key={draft.componentId}><button className="tool-btn" onClick={() => setReviewComponent(draft.componentId)}>Сверить {draft.base.name} #{draft.componentId}</button></p>)}</div></div></div>}
        {invalidConnections.length > 0 && <div className="calculation-error" role="alert"><Icon name="alert" /><div><strong>Соединения требуют исправления: {invalidConnections.length}</strong><p>Сохранённые данные оставлены для проверки. Выберите связь, чтобы исправить схему или удалить её.</p><div className="connection-diagnostics-list">{invalidConnections.map(c => <p key={c.id}><button className="tool-btn" onClick={() => { setSelectedConnection(c.id); setSelectedComponent(null); }}>Выбрать связь #{c.id}</button> {(c.validationErrors || []).map(reason => connectionReasons[reason] || reason).join('; ')}</p>)}</div></div></div>}

        <div className="canvas-scroll" ref={containerRef}
          onWheel={handleWheel}
          onDragOver={handleDragOver}
          onDrop={handleCanvasDrop}
        >
          <svg ref={svgRef} className="main-canvas"
            viewBox={`${viewBox.x} ${viewBox.y} ${viewBox.w} ${viewBox.h}`}
            preserveAspectRatio="xMidYMid meet"
            onMouseDown={handleMouseDown}
            onMouseMove={onMouseMove}
            onMouseUp={handleMouseUp}
            onMouseLeave={resetInteraction}
          >
            <defs>
              <pattern id="grid" width="20" height="20" patternUnits="userSpaceOnUse">
                <circle cx="1" cy="1" r="1" fill="var(--grid-color)" />
              </pattern>
              <pattern id="grid-lg" width="100" height="100" patternUnits="userSpaceOnUse">
                <rect width="100" height="100" fill="none" stroke="var(--grid-color)" strokeWidth="1.2" />
              </pattern>
            </defs>
            <rect x={viewBox.x - viewBox.w} y={viewBox.y - viewBox.h} width={viewBox.w * 3} height={viewBox.h * 3} fill="url(#grid)" style={{ pointerEvents: 'none' }} />
            <g className="connections-layer">
              {connections.map(renderConnection)}
              {tempLine && <line x1={tempLine.x1} y1={tempLine.y1} x2={tempLine.x2} y2={tempLine.y2} className="connection-line-temp" />}
            </g>
            <g className="components-layer">
              {components.map(renderComponent)}
            </g>
          </svg>
          {components.length === 0 && <div className="canvas-empty"><div className="empty-network"><Icon name="grid" width="32" height="32" /></div><p className="eyebrow">От идеи — к модели</p><h2>{currentSchemeId ? 'Добавьте первое оборудование' : 'Ваша энергосистема начинается здесь'}</h2><p>{currentSchemeId ? 'Откройте каталог, выберите элемент и соедините его терминалы с другими объектами.' : 'Создайте схему, добавьте оборудование и исследуйте установившийся режим сети.'}</p><button className="tool-btn primary" onClick={() => currentSchemeId ? setLibraryVisible(true) : setCreateDialog(true)}><Icon name={currentSchemeId ? 'box' : 'plus'} />{currentSchemeId ? 'Открыть каталог' : 'Создать схему'}</button><span>Симметричный AC-режим · экспериментальная модель</span></div>}
        </div>
        <div className="workspace-status"><span className="status-dot" /><span>{currentSchemeId ? `${components.length} объектов · ${connections.length} соединений` : 'Схема не выбрана'}</span><span className="status-hint">Колесо — масштаб · пустая область — перемещение</span></div>
      </main>

      {inspectorVisible && <PropertiesPanel
        selectedComponent={selectedComp}
        selectedConnection={selectedConnection}
        currentSchemeId={currentSchemeId}
        onSaveParam={onSaveParam}
        parameterResets={selectedComp ? parameterResets[selectedComp.id] : undefined}
      />}

      {resultsVisible && lastResult && <ResultsModal result={lastResult} schemeName={schemeName} onClose={closeModal} />}
      {reviewedDraft && <RecoveryDialog key={`${reviewedDraft.schemeId}:${reviewedDraft.componentId}`} draft={reviewedDraft} onResolve={resolveComponentDraft} onResolveDeletion={resolveComponentDeletion} onClose={() => setReviewComponent(null)} />}
      {createDialog && <NewSchemeDialog onCreate={async (name, description) => { const created = await handleCreateScheme(name, description); if (created) { setLastResult(null); setSelectedComponent(null); setSelectedConnection(null); } return created; }} onClose={() => setCreateDialog(false)} />}
      {pendingDrop && (
        <ModelSelectModal
          componentType={pendingDrop.item}
          onConfirm={handleModelSelectConfirm}
          onCancel={() => setPendingDrop(null)}
        />
      )}
    </div>
  );
};

export default SchemeEditor;
