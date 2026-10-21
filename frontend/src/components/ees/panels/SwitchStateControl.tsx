import { useState } from 'react';
import { switchDisplay } from '../../../domain/switch-position';

export function SwitchStateControl({ kind, params, onSave }: {
  kind: 'breaker' | 'disconnector' | 'grounding_switch';
  params: Readonly<Record<string, string>>;
  onSave: (key: string, value: string) => void | Promise<void>;
}) {
  const [pending, setPending] = useState(false);
  const [error, setError] = useState('');
  const display = switchDisplay(kind, params);
  const explicit = Object.prototype.hasOwnProperty.call(params, 'status');
  async function change(value: string) {
    setPending(true);
    setError('');
    try { await onSave('status', value); }
    catch (cause) { setError(cause instanceof Error ? cause.message : 'Не удалось сохранить положение'); }
    finally { setPending(false); }
  }
  return <section className="switch-state-control" aria-label="Положение коммутационного аппарата" aria-busy={pending}>
    <h4>Положение аппарата</h4>
    <p>{display.description}</p>
    <div role="group" aria-label="Изменить положение">
      <button type="button" className="tool-btn" aria-pressed={display.position === 'closed'}
        disabled={pending || (explicit && display.position === 'closed')} onClick={() => void change('true')}>Замкнут</button>
      <button type="button" className="tool-btn" aria-pressed={display.position === 'open'}
        disabled={pending || (explicit && display.position === 'open')} onClick={() => void change('false')}>Разомкнут</button>
    </div>
    <p role="status">{pending ? 'Сохраняется… Рисунок изменится после подтверждения.' : 'Показаны подтверждённые данные. Смена положения сохраняется сразу.'}</p>
    {kind === 'grounding_switch' && <p>Положение сохраняется; расчёт заземляющего аппарата пока не поддержан.</p>}
    {error && <p role="alert">{error}</p>}
  </section>;
}
