import type { OpenCalculationArchive } from '../../api/calculation-archives-api';
import { ResultsModal } from '../../components/ees/panels/ResultsModal';
import { ArchiveInputs } from './ArchiveInputs';

const date=new Intl.DateTimeFormat('ru-RU',{dateStyle:'medium',timeStyle:'short'});
export function ArchiveResultView({archive:opened,onClose}:{archive:OpenCalculationArchive;onClose:()=>void}){
  return <ResultsModal result={opened.result} schemeName={opened.metadata.schemeName} onClose={onClose} context={<>
    <div className="archive-origin"><strong>Архив №{opened.metadata.id} · {date.format(new Date(opened.metadata.createdAt))}</strong><p>Исходная схема №{opened.metadata.schemeId} · топология {opened.metadata.topologyRevision}. Результат открыт со своим входом, независимо от текущей схемы.</p>
      <details><summary>Контрольные суммы и размеры</summary><dl><dt>Вход · {opened.metadata.inputBytes} байт</dt><dd>{opened.metadata.inputSha256}</dd><dt>Результат · {opened.metadata.resultBytes} байт</dt><dd>{opened.metadata.resultSha256}</dd>{opened.metadata.provenanceSha256 && <><dt>Происхождение · {opened.metadata.provenanceBytes} байт</dt><dd>{opened.metadata.provenanceSha256}</dd></>}</dl><p>Сервер проверил SHA-256. Клиент сверил идентификатор, ETag и размер каждого тела.</p></details>
    </div><ArchiveInputs key={opened.metadata.id} input={opened.input} provenance={opened.provenance}/>
  </>}/>;
}
