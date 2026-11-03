export interface ResultSnapshot {
  schemeName: string;
  receivedAt: string;
  changedWhileRunning: boolean;
}
/** A local editor receipt never claims equivalence with the server input hash. */
export function ResultSnapshotNotice({ snapshot, stale }: { snapshot: ResultSnapshot; stale: boolean }) {
  return <section className="result-snapshot" aria-label="Контекст последнего расчёта">
    <strong>Снимок выполненного расчёта</strong>
    <p>Схема при запросе: {snapshot.schemeName}. Получен: <time dateTime={snapshot.receivedAt}>{new Date(snapshot.receivedAt).toLocaleString('ru-RU')}</time>.</p>
    {snapshot.changedWhileRunning ? <p role="alert">Во время запроса менялись расчётные данные. Сопоставление результата с текущей схемой требует нового запуска.</p>
      : stale ? <p role="alert">Параметры, состав схемы или настройки расчёта изменились. Показанный результат относится к предыдущему запросу.</p>
        : <p>Изменения схемы не пересчитывают этот результат автоматически. Изменения из других сессий проверяются новым запуском.</p>}
  </section>;
}
