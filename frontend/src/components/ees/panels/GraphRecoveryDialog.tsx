import { useEffect, useRef, useState } from 'react';
import { Dialog } from '../../ui/Dialog';
import type { GraphFailure, GraphReview } from '../graph-writes';

function describe(failure: GraphFailure) {
  const intent = failure.intent;
  if (intent.kind === 'create-component') return `Добавить «${intent.name}», тип #${intent.typeId}, паспорт ${intent.equipmentModelId ?? 'не выбран'}, положение (${intent.x}, ${intent.y})`;
  if (intent.kind === 'delete-connection') return `Удалить связь #${intent.id}`;
  return `Соединить #${intent.from}:${intent.fromPort} → #${intent.to}:${intent.toPort}`;
}

function observed(failure: GraphFailure, review: GraphReview) {
  const intent = failure.intent;
  if (intent.kind === 'create-component') {
    const candidates = review.server.components.filter(component => component.typeId === intent.typeId &&
      component.name === intent.name && (component.equipmentModelId ?? null) === intent.equipmentModelId &&
      component.x === intent.x && component.y === intent.y);
    return candidates.length ? `Совпадают указанные признаки: ${candidates.map(component => `«${component.name}» #${component.id}`).join(', ')}. Это не доказательство выполнения команды.` : 'Объектов с такими признаками нет. Исходная команда могла выполниться, а объект — измениться.';
  }
  const connections = review.server.connections.filter(connection => intent.kind === 'delete-connection' ? connection.id === intent.id :
    (connection.from === intent.from && connection.to === intent.to && connection.fromPort === intent.fromPort && connection.toPort === intent.toPort) ||
    (connection.from === intent.to && connection.to === intent.from && connection.fromPort === intent.toPort && connection.toPort === intent.fromPort));
  return connections.length ? `Сервер: ${connections.map(connection => `связь #${connection.id}: #${connection.from}:${connection.fromPort} → #${connection.to}:${connection.toPort}`).join('; ')}` : 'В прочитанном составе такая связь отсутствует.';
}

export function GraphRecoveryDialog({ onRead, onAccept, onRetry, onClose }: {
  onRead: () => Promise<GraphReview>;
  onAccept: (review: GraphReview, selected: ReadonlySet<number>) => Promise<void>;
  onRetry?: (review: GraphReview, failureId: number) => Promise<void>;
  onClose: () => void;
}) {
  const [review, setReview] = useState<GraphReview>();
  const [selected, setSelected] = useState(new Set<number>());
  const [confirmed, setConfirmed] = useState(false);
  const [retryConfirmed, setRetryConfirmed] = useState(false);
  const [busy, setBusy] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const [request, refresh] = useState(0);
  const alive = useRef(true);
  const submitting = useRef(false);
  useEffect(() => { alive.current = true; return () => { alive.current = false; }; }, []);
  useEffect(() => {
    let active = true;
    setBusy(true); setError(''); setReview(undefined); setSelected(new Set()); setConfirmed(false); setRetryConfirmed(false);
    onRead().then(value => { if (active) setReview(value); })
      .catch(reason => { if (active) setError(reason instanceof Error ? reason.message : 'Не удалось прочитать состав схемы'); })
      .finally(() => { if (active) setBusy(false); });
    return () => { active = false; };
  }, [onRead, request]);
  const candidate = selected.size === 1 ? review?.failures.find(failure => selected.has(failure.id) && failure.intent.kind === 'create-connection' && failure.intent.commandId) : undefined;
  const perform = async (mode: 'accept' | 'retry') => {
    if (!review || !selected.size || submitting.current ||
        (mode === 'accept' ? !confirmed : !retryConfirmed || !candidate || !onRetry)) return;
    submitting.current = true; setSaving(true); setError('');
    try {
      if (mode === 'retry' && candidate && onRetry) await onRetry(review, candidate.id);
      else await onAccept(review, new Set(selected));
      if (alive.current) onClose();
    }
    catch (reason) {
      if (alive.current) { setError(reason instanceof Error ? reason.message : 'Не удалось разрешить изменение состава'); setReview(undefined); setConfirmed(false); setRetryConfirmed(false); }
    } finally { submitting.current = false; if (alive.current) setSaving(false); }
  };
  return <Dialog wide title="Сверка состава схемы" closeDisabled={saving} onClose={onClose}>
    <p className="dialog-intro">Сервер мог сохранить команду, даже если её ответ потерян. Сверьте состав, затем выберите принятие серверного состояния или повтор создания одной связи.</p>
    {busy && <p role="status">Ожидание записей и чтение схемы…</p>}
    {error && <p role="alert">{error}</p>}
    {review && <>
      <p>Схема #{review.schemeId}: {review.server.components.length} объектов, {review.server.connections.length} связей на момент чтения. Правки других клиентов после чтения здесь не отражены.</p>
      <div className="results-table-wrap"><table className="results-table recovery-table"><caption>Неподтверждённые намерения и прочитанный состав</caption>
        <thead><tr><th scope="col">Ваше намерение</th><th scope="col">Состояние на сервере</th><th scope="col">Причина</th></tr></thead>
        <tbody>{review.failures.map(failure => <tr key={failure.id}><th scope="row"><label><input type="checkbox" aria-label={`Принять сервер для намерения ${failure.id}`} checked={selected.has(failure.id)} disabled={saving} onChange={event => { setConfirmed(false); setRetryConfirmed(false); setSelected(previous => { const next = new Set(previous); if (event.target.checked) next.add(failure.id); else next.delete(failure.id); return next; }); }} /> {describe(failure)}</label></th><td>{observed(failure, review)}</td><td>{failure.reason}</td></tr>)}</tbody>
      </table></div>
      <p className="dialog-intro">Невыбранные намерения и черновики параметров/положения останутся в журнале и продолжат блокировать расчёт. Совпадение объектов по имени и координатам не определяет их идентичность.</p>
      <label><input type="checkbox" checked={confirmed} disabled={saving} onChange={event => setConfirmed(event.target.checked)} /> Принимаю прочитанный состав; отказываюсь только от выбранных намерений</label>
      {onRetry && <section className="result-notice graph-retry-notice" aria-label="Повтор создания связи">
        <p>Для повтора выберите одно создание связи. Будет отправлена исходная команда. Если она уже выполнена, сервер вернёт её подтверждение. Связь, удалённая после выполнения команды, не восстанавливается.</p>
        <label><input type="checkbox" checked={retryConfirmed} disabled={saving || !candidate} onChange={event => setRetryConfirmed(event.target.checked)} /> Подтверждаю повтор создания выбранной связи</label>
        <p>Расчёт остаётся заблокирован до подтверждения и свежей загрузки схемы. Другие черновики сохраняются.</p>
      </section>}
    </>}
    <div className="dialog-actions recovery-actions">
      <button className="tool-btn primary" disabled={busy || saving || !review || !selected.size || !confirmed} onClick={() => { void perform('accept'); }}>Принять состав для выбранных</button>
      {onRetry && <button className="tool-btn" disabled={busy || saving || !candidate || !retryConfirmed} onClick={() => { void perform('retry'); }}>Повторить создание связи</button>}
      <button className="tool-btn" disabled={busy || saving} onClick={() => refresh(value => value + 1)}>Обновить сравнение</button>
      <button className="tool-btn" disabled={saving} onClick={onClose}>Оставить намерения в журнале</button>
    </div>
  </Dialog>;
}
