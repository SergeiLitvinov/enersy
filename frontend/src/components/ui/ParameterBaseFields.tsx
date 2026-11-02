import { useId } from 'react';
import './ParameterBaseFields.css';

export function ParameterBaseFields({ power, voltage, onChange }: {
  power: string; voltage: string; onChange: (field: 'power' | 'voltage', value: string) => void;
}) {
  const id = useId();
  return <fieldset className="parameter-base-fields">
    <legend>Исходный базис p.u.</legend>
    <p>Базис этого коэффициента, отдельно от базиса исследования. Число не пересчитывается.</p>
    <div className="parameter-base-grid">
      <label htmlFor={`${id}-power`}>Sб · трёхфазная мощность, МВА<input id={`${id}-power`} value={power} inputMode="decimal" maxLength={64} placeholder="Укажите явно" onChange={event => onChange('power', event.target.value)} /></label>
      <label htmlFor={`${id}-voltage`}>Uб · линейное RMS-напряжение, кВ<input id={`${id}-voltage`} value={voltage} inputMode="decimal" maxLength={64} placeholder="Укажите явно" onChange={event => onChange('voltage', event.target.value)} /></label>
    </div>
  </fieldset>;
}
