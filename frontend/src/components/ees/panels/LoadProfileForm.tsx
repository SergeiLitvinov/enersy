import { parameterSourceBase, parameterUnitLabel, type ParameterUnitDeclaration } from '../../../api/parameter-unit-declaration';
import { useRef, useState, type FormEvent } from 'react';
import { loadProfileDraft, loadProfileError, loadProfileKeys, loadProfileMode, loadProfilePatch, loadProfileUnits, type LoadProfileDraft, type LoadProfileKey } from '../../../domain/load-profile';
import { loadProfileDeclaration, loadUnitContext, type LoadUnitPolicy } from '../../../api/load-profile-declaration';
import { parameterBaseLabel } from '../../../domain/parameter-base';
import './LoadProfileForm.css';

export function LoadProfileForm({ componentId, params, onSave, parameterResets = {}, unitDeclaration }: {
  componentId: number; params: Readonly<Record<string, string>>;
  onSave: (values: Readonly<Record<string, string>>, declaration: ParameterUnitDeclaration) => Promise<void>;
  parameterResets?: Readonly<Record<string, number>>;
  unitDeclaration?: ParameterUnitDeclaration;
}) {
  const confirmed = loadProfileDraft(params);
  const units = Object.fromEntries(loadProfileKeys.map(key => [key, parameterUnitLabel(unitDeclaration, key, '')]));
  const contexts = Object.fromEntries(loadProfileKeys.map(key => [key, loadUnitContext(unitDeclaration, key)]));
  const [policy, setPolicy] = useState<LoadUnitPolicy>('canonical');
  const [state, setState] = useState(() => ({ confirmed, draft: { ...confirmed }, units, contexts, resets: { ...parameterResets }, conflicted: false, unitsAcknowledged: false, submitted: null as { draft: LoadProfileDraft; contexts: Record<string, string> } | null }));
  const [busy, setBusy] = useState(false), [message, setMessage] = useState(''), [failure, setFailure] = useState('');
  const pending = useRef(false);
  if (loadProfileKeys.some(key => state.confirmed[key] !== confirmed[key] || state.contexts[key] !== contexts[key] || (state.resets[key] ?? 0) !== (parameterResets[key] ?? 0))) {
    const acknowledged = state.submitted !== null && loadProfileKeys.every(key => confirmed[key] === state.submitted!.draft[key] && contexts[key] === state.submitted!.contexts[key]);
    const draft = acknowledged ? { ...confirmed } : { ...state.draft };
    let conflicted = acknowledged ? false : state.conflicted;
    for (const key of loadProfileKeys) {
      const reset = (state.resets[key] ?? 0) !== (parameterResets[key] ?? 0);
      if (acknowledged) continue;
      if (contexts[key] !== state.contexts[key] && state.unitsAcknowledged) conflicted = true;
      if (reset || draft[key] === state.confirmed[key]) draft[key] = confirmed[key];
      else if (contexts[key] !== state.contexts[key]) conflicted = true;
      else if (confirmed[key] !== state.confirmed[key] && confirmed[key] !== draft[key]) conflicted = true;
    }
    setState({ confirmed, draft, units, contexts, resets: { ...parameterResets }, conflicted, unitsAcknowledged: acknowledged ? false : state.unitsAcknowledged,
      submitted: acknowledged ? null : state.submitted });
  }
  const mode = loadProfileMode(state.draft.zip_enabled);
  const dirty = state.unitsAcknowledged || loadProfileKeys.some(key => state.draft[key] !== state.confirmed[key]);
  let declaration: ParameterUnitDeclaration | undefined;
  let declarationError = '';
  try { declaration = loadProfileDeclaration(policy, state.draft, unitDeclaration); }
  catch (error) { declarationError = error instanceof Error ? error.message : 'Проверьте единицы профиля.'; }
  const invalid = loadProfileError(state.draft) || declarationError;
  const change = (key: LoadProfileKey, value: string) => {
    setState(previous => ({ ...previous, draft: { ...previous.draft, [key]: value } }));
    setMessage(''); setFailure('');
  };
  const restore = () => { setState({ confirmed, draft: { ...confirmed }, units, contexts, resets: { ...parameterResets }, conflicted: false, unitsAcknowledged: false, submitted: null }); setMessage(''); setFailure(''); };
  async function submit(event: FormEvent) {
    event.preventDefault();
    if (pending.current || !dirty || invalid || state.conflicted || !state.unitsAcknowledged || !declaration) return;
    const patch = loadProfilePatch(state.draft);
    const submittedContexts = Object.fromEntries(loadProfileKeys.map(key => [key, loadUnitContext(declaration, key)]));
    setState(previous => ({ ...previous, submitted: { draft: patch, contexts: submittedContexts } }));
    pending.current = true; setBusy(true); setMessage(''); setFailure('');
    try {
      await onSave(patch, declaration);
      // A no-op acknowledgement may not change any incoming props. Consume its
      // marker now, so a later review reset cannot erase a newer local draft.
      setState(previous => ({ ...previous, unitsAcknowledged: false,
        submitted: loadProfileKeys.every(key => previous.confirmed[key] === patch[key] && previous.contexts[key] === submittedContexts[key]) ? null : previous.submitted }));
      setMessage('Профиль сохранён');
    } catch (error) { setState(previous => ({ ...previous, submitted: null })); setFailure(error instanceof Error ? error.message : 'Сохранение профиля не подтверждено'); }
    finally { pending.current = false; setBusy(false); }
  }
  const input = (key: LoadProfileKey, name: string, hint?: string) => <label className="load-profile-field" htmlFor={`load-${componentId}-${key}`}>
    <span>{name}<small>{state.unitsAcknowledged && declaration ? declaration.units[key] : parameterUnitLabel(unitDeclaration, key, 'Единица не задана')}</small></span>
    <input id={`load-${componentId}-${key}`} inputMode="decimal" type="text" value={state.draft[key]} onChange={event => change(key, event.target.value)} />
    {(policy === 'saved' || !state.unitsAcknowledged) && parameterUnitLabel(unitDeclaration, key, '') === 'p.u.' && <small>{parameterBaseLabel(parameterSourceBase(unitDeclaration, key))}</small>}
    {hint && <small>{hint}</small>}
  </label>;
  return <form className="load-profile-form" aria-label="Профиль нагрузки" onSubmit={submit}>
    <fieldset disabled={busy}><legend>Мощность и зависимость от напряжения</legend>
      <label className="load-profile-field" htmlFor={`load-${componentId}-mode`}><span>Модель нагрузки<small>{state.unitsAcknowledged ? '1' : parameterUnitLabel(unitDeclaration, 'zip_enabled', 'Единица не задана')}</small></span>
        <select id={`load-${componentId}-mode`} value={mode} onChange={event => change('zip_enabled', String(event.target.value === 'zip'))}>
          {mode === 'unknown' && <option value="unknown" disabled>Неизвестный профиль</option>}
          <option value="pq">PQ · постоянная мощность</option><option value="zip">ZIP · зависимость от напряжения</option>
        </select>
      </label>
      <label className="load-profile-field" htmlFor={`load-${componentId}-representation`}><span>Представление величин</span>
        <select id={`load-${componentId}-representation`} value={policy} onChange={event => {
          setPolicy(event.target.value as LoadUnitPolicy);
          setState(previous => ({ ...previous, unitsAcknowledged: false })); setMessage(''); setFailure('');
        }}><option value="canonical">Задать МВт, Мвар и кВ</option><option value="saved">Сохранённые единицы и базисы</option></select>
      </label>
      {input('p', 'Активная мощность P')}
      {input('q', 'Реактивная мощность Q', 'Если Q не задана, модель принимает 0 Мвар.')}
      {input('voltage_nom', 'Номинальное напряжение', mode === 'zip' ? 'Обязательно для ZIP; линейное действующее значение.' : 'Необязательно для PQ; линейное действующее значение.')}
      {mode === 'zip' ? <>
        <p>Мощности P и Q заданы при номинальном напряжении. Доли для них независимы; каждая колонка должна давать сумму 1.</p>
        <div className="load-fractions"><table><caption>Доли статической ZIP-нагрузки</caption><thead><tr><th>Составляющая</th><th>P</th><th>Q</th></tr></thead><tbody>
          {([['z', 'Z · сопротивление'], ['i', 'I · модуль тока'], ['p', 'P · мощность']] as const).map(([term, label]) => <tr key={term}><th scope="row">{label}</th>
            {(['p', 'q'] as const).map(part => { const key = `zip_${part}_${term}` as const; return <td key={part}><input aria-label={`Доля ${part.toUpperCase()}: ${label}`} aria-describedby={`load-${componentId}-${key}-unit`} type="text" inputMode="decimal" value={state.draft[key]} onChange={event => change(key, event.target.value)} /><small id={`load-${componentId}-${key}-unit`} className="load-fraction-unit">{state.unitsAcknowledged ? '1' : parameterUnitLabel(unitDeclaration, key, 'Ед.?')}</small></td>; })}
          </tr>)}
        </tbody></table></div>
        <p className="load-profile-equation">P(U) = Pном · (pZ·u² + pI·u + pP)<br />Q(U) = Qном · (qZ·u² + qI·u + qP)<br />u = U / Uном</p>
      </> : <p>Мощность не зависит от напряжения. Применение PQ очищает сохранённые доли ZIP.</p>}
      <p>Положительные P и Q означают потребление. Настройки применяются целиком; до применения расчёт использует сохранённый профиль.</p>
      <label className="load-unit-declaration" htmlFor={`load-${componentId}-units`}>
        <input id={`load-${componentId}-units`} type="checkbox" checked={state.unitsAcknowledged} onChange={event => {
          const checked = event.target.checked;
          setState(previous => ({ ...previous, unitsAcknowledged: checked })); setMessage(''); setFailure('');
        }} />
        <span>{policy === 'canonical' ? 'Задаю единицы: P — МВт, Q — Мвар, Uном — кВ (линейное RMS), режим и доли ZIP — 1.' : `Сохраняю представление: P — ${declaration?.units.p ?? 'не задано'}, Q — ${declaration?.units.q ?? 'не задано'}, Uном — ${declaration?.units.voltage_nom ?? 'не задано'}; исходные базисы показаны у полей; режим и доли ZIP — 1.`}</span>
      </label>
      <p>Единицы задаются для всего профиля. Числа не пересчитываются.</p>
      {policy === 'canonical' && state.unitsAcknowledged && loadProfileKeys.some(key => state.units[key] && (state.units[key] !== loadProfileUnits[key] || !!parameterSourceBase(unitDeclaration, key))) && <p role="alert">Обозначения единиц изменятся; исходные базисы p.u. будут удалены. Проверьте каждое число в указанных единицах перед применением; программа его не пересчитывает.</p>}
      {!state.unitsAcknowledged && !message && <p className="load-profile-validation" role="status">Для применения изменений явно задайте единицы этого профиля.</p>}
      {state.conflicted && <p role="alert">Сохранённые значения, единицы или исходные базисы изменились во время редактирования. Сверьте их, вернув сохранённый профиль.</p>}
      {invalid && <p className="load-profile-validation" role="status">{invalid}</p>}
      {failure && <p role="alert">{failure}</p>}
      {message && <p role="status">{message}</p>}
      <div className="load-profile-actions"><button className="tool-btn" type="submit" disabled={!dirty || !!invalid || state.conflicted || !state.unitsAcknowledged}>{busy ? 'Сохранение…' : 'Применить профиль'}</button>
        <button className="tool-btn" type="button" disabled={!dirty && !state.conflicted} onClick={restore}>Вернуть сохранённый</button></div>
    </fieldset>
  </form>;
}
