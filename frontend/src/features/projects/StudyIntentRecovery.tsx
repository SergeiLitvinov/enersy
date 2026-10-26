import { useEffect, useRef, useState } from 'react';
import { StudyWriteError, type StudyVersion } from '../../api/studies-api';
import { executeStudyIntent, type StudyIntent, type StudyIntentJournal } from './study-intent-journal';
import { StudyDocumentView } from './StudyDocumentView';

export function StudyIntentRecovery({ intent, journal, writable, onResolved, onDiscarded, onUnavailable }: {
  intent: StudyIntent; journal: StudyIntentJournal; writable: boolean; onResolved: (v: StudyVersion) => void; onDiscarded: () => void; onUnavailable: () => void;
}) {
  const [busy, setBusy] = useState(false), [error, setError] = useState('');
  const [controller] = useState(() => new AbortController()); const sending = useRef(false);
  useEffect(() => () => controller.abort(), [controller]);
  async function retry() {
    if (sending.current || !writable) return;
    sending.current = true; setBusy(true); setError('');
    try {
      journal.prepare(intent);
      const result = await executeStudyIntent(intent, journal.scope, controller.signal);
      if (!controller.signal.aborted) { journal.clear(intent.command); onResolved(result); }
    } catch (e) {
      if (!controller.signal.aborted) {
        setError('Исход команды не подтверждён. Локальная запись сохранена. Проверьте доступ и историю; не создавайте замену с новым ключом автоматически.');
        if (e instanceof StudyWriteError && ([401, 404].includes(e.status) || e.code === 'study_session_changed')) onUnavailable();
      }
    } finally { sending.current = false; if (!controller.signal.aborted) setBusy(false); }
  }
  function discard() {
    if (busy || !window.confirm('Удалить только локальную запись команды? Серверная запись могла выполниться и этим действием не отменяется. Сначала проверьте историю.')) return;
    try { journal.clear(intent.command); onDiscarded(); } catch { setError('Не удалось очистить локальный журнал. Новая запись заблокирована.'); }
  }
  return <section className="study-comparison" aria-label="Восстановление команды Study">
    <h3>Проверьте прежнее сохранение</h3><p>«{intent.document.name}» · источник №{intent.schemeId} · топология {intent.topology}{intent.studyId && ` · исследование №${intent.studyId}, ожидаемая версия ${intent.expected}`}.</p>
    <p className="projects-note">Это локальное намерение из этой вкладки, а не доказательство сохранения. Повтор выполняется только по кнопке, с прежним ключом и данными. Если прежняя команда не успела выполниться, сервер попробует захватить источник заново при прежней ревизии топологии; ревизии всех параметров пока не проверяются.</p>
    <details><summary>Настройки прежней команды</summary><StudyDocumentView document={intent.document} /></details>
    {error && <p role="alert" className="projects-error">{error}</p>}
    <div className="study-actions"><button className="tool-btn primary" disabled={busy || !writable} onClick={() => void retry()}>{busy ? 'Проверяем прежнюю команду…' : 'Проверить прежнюю команду'}</button><button className="tool-btn" disabled={busy} onClick={discard}>Удалить локальную запись команды</button></div>
  </section>;
}
