import { useRef, useState, type FormEvent } from 'react';
import { loadProfileDraft, loadProfileError, loadProfileKeys, loadProfileMode, loadProfilePatch, type LoadProfileKey } from '../../../domain/load-profile';
import './LoadProfileForm.css';

export function LoadProfileForm({ componentId, params, onSave, parameterResets = {} }: {
  componentId: number; params: Readonly<Record<string, string>>;
  onSave: (values: Readonly<Record<string, string>>) => Promise<void>;
  parameterResets?: Readonly<Record<string, number>>;
}) {
  const confirmed = loadProfileDraft(params);
  const [state, setState] = useState(() => ({ confirmed, draft: { ...confirmed }, resets: { ...parameterResets }, conflicted: false }));
  const [busy, setBusy] = useState(false), [message, setMessage] = useState(''), [failure, setFailure] = useState('');
  const pending = useRef(false);
  if (loadProfileKeys.some(key => state.confirmed[key] !== confirmed[key] || (state.resets[key] ?? 0) !== (parameterResets[key] ?? 0))) {
    const draft = { ...state.draft };
    let conflicted = state.conflicted;
    for (const key of loadProfileKeys) {
      const reset = (state.resets[key] ?? 0) !== (parameterResets[key] ?? 0);
      if (reset || draft[key] === state.confirmed[key]) draft[key] = confirmed[key];
      else if (confirmed[key] !== state.confirmed[key] && confirmed[key] !== draft[key]) conflicted = true;
    }
    setState({ confirmed, draft, resets: { ...parameterResets }, conflicted });
  }
  const mode = loadProfileMode(state.draft.zip_enabled);
  const dirty = loadProfileKeys.some(key => state.draft[key] !== state.confirmed[key]);
  const invalid = loadProfileError(state.draft);
  const change = (key: LoadProfileKey, value: string) => {
    setState(previous => ({ ...previous, draft: { ...previous.draft, [key]: value } }));
    setMessage(''); setFailure('');
  };
  const restore = () => { setState({ confirmed, draft: { ...confirmed }, resets: { ...parameterResets }, conflicted: false }); setMessage(''); setFailure(''); };
  async function submit(event: FormEvent) {
    event.preventDefault();
    if (pending.current || !dirty || invalid || state.conflicted) return;
    const patch = loadProfilePatch(state.draft);
    pending.current = true; setBusy(true); setMessage(''); setFailure('');
    try {
      await onSave(patch);
      setMessage('Профиль сохранён');
    } catch (error) { setFailure(error instanceof Error ? error.message : 'Сохранение профиля не подтверждено'); }
    finally { pending.current = false; setBusy(false); }
  }
  const input = (key: LoadProfileKey, name: string, unit: string, hint?: string) => <label className="load-profile-field" htmlFor={`load-${componentId}-${key}`}>
    <span>{name}<small>{unit}</small></span>
    <input id={`load-${componentId}-${key}`} inputMode="decimal" type="text" value={state.draft[key]} onChange={event => change(key, event.target.value)} />
    {hint && <small>{hint}</small>}
  </label>;
  return <form className="load-profile-form" aria-label="Профиль нагрузки" onSubmit={submit}>
    <fieldset disabled={busy}><legend>Мощность и зависимость от напряжения</legend>
      <label className="load-profile-field" htmlFor={`load-${componentId}-mode`}><span>Модель нагрузки</span>
        <select id={`load-${componentId}-mode`} value={mode} onChange={event => change('zip_enabled', String(event.target.value === 'zip'))}>
          {mode === 'unknown' && <option value="unknown" disabled>Неизвестный профиль</option>}
          <option value="pq">PQ · постоянная мощность</option><option value="zip">ZIP · зависимость от напряжения</option>
        </select>
      </label>
      {input('p', 'Активная мощность P', 'МВт')}
      {input('q', 'Реактивная мощность Q', 'Мвар', 'Если Q не задана, модель принимает 0 Мвар.')}
      {input('voltage_nom', 'Номинальное напряжение', 'кВ', mode === 'zip' ? 'Обязательно для ZIP; линейное действующее значение.' : 'Необязательно для PQ; линейное действующее значение.')}
      {mode === 'zip' ? <>
        <p>Мощности P и Q заданы при номинальном напряжении. Доли для них независимы; каждая колонка должна давать сумму 1.</p>
        <div className="load-fractions"><table><caption>Доли статической ZIP-нагрузки</caption><thead><tr><th>Составляющая</th><th>P</th><th>Q</th></tr></thead><tbody>
          {([['z', 'Z · сопротивление'], ['i', 'I · модуль тока'], ['p', 'P · мощность']] as const).map(([term, label]) => <tr key={term}><th scope="row">{label}</th>
            {(['p', 'q'] as const).map(part => { const key = `zip_${part}_${term}` as const; return <td key={part}><input aria-label={`Доля ${part.toUpperCase()}: ${label}`} type="text" inputMode="decimal" value={state.draft[key]} onChange={event => change(key, event.target.value)} /></td>; })}
          </tr>)}
        </tbody></table></div>
        <p className="load-profile-equation">P(U) = Pном · (pZ·u² + pI·u + pP)<br />Q(U) = Qном · (qZ·u² + qI·u + qP)<br />u = U / Uном</p>
      </> : <p>Мощность не зависит от напряжения. Применение PQ очищает сохранённые доли ZIP.</p>}
      <p>Положительные P и Q означают потребление. Настройки применяются целиком; до применения расчёт использует сохранённый профиль.</p>
      {state.conflicted && <p role="alert">Сохранённые значения изменились во время редактирования. Сверьте их, вернув сохранённый профиль.</p>}
      {invalid && <p className="load-profile-validation" role="status">{invalid}</p>}
      {failure && <p role="alert">{failure}</p>}
      {message && <p role="status">{message}</p>}
      <div className="load-profile-actions"><button className="tool-btn" type="submit" disabled={!dirty || !!invalid || state.conflicted}>{busy ? 'Сохранение…' : 'Применить профиль'}</button>
        <button className="tool-btn" type="button" disabled={!dirty && !state.conflicted} onClick={restore}>Вернуть сохранённый</button></div>
    </fieldset>
  </form>;
}
