import { useState } from 'react';
import { Dialog } from '../../ui/Dialog';
import { parseTerminalVoltageLimits, type TerminalVoltageLimit } from '../../../api/operating-assessment';
import './OperatingLimitsDialog.css';

export interface LimitTarget {component_id:number;terminal:number;label:string}
const key = (target: Pick<LimitTarget,'component_id'|'terminal'>) => `${target.component_id}/${target.terminal}`;
export function OperatingLimitsDialog({ targets, limits, stale, onApply, onClose }: {
  targets: readonly LimitTarget[]; limits: readonly TerminalVoltageLimit[]; stale:boolean;
  onApply:(limits:TerminalVoltageLimit[])=>void; onClose:()=>void;
}) {
  const [rows,setRows] = useState(()=>limits.map(l=>({target:key(l),min:String(l.min_kv),max:String(l.max_kv)})));
  const options = new Map(targets.map(t=>[key(t),t]));
  let parsed: TerminalVoltageLimit[] = [], error = '';
  try {
    if (stale && rows.length) throw new Error('Состав или связи схемы изменились. Очистите границы и выполните новый расчёт, затем задайте их заново.');
    parsed = parseTerminalVoltageLimits(rows.map(r=>{
      const target=options.get(r.target);
      if (!target || !r.min.trim() || !r.max.trim()) throw new Error('Выберите терминал и заполните обе границы.');
      return {component_id:target.component_id,terminal:target.terminal,min_kv:Number(r.min),max_kv:Number(r.max)};
    }));
  } catch(e) { error = e instanceof Error && e.message!=='Некорректная оценка режимных ограничений' ? e.message : 'Границы должны быть положительными, минимум не больше максимума. Каждый терминал задаётся один раз.'; }
  const change = (index:number,field:'target'|'min'|'max',value:string) => setRows(previous=>previous.map((r,i)=>i===index?{...r,[field]:value}:r));
  return <Dialog title="Границы напряжения" onClose={onClose} wide>
    <p className="dialog-intro">Линейное действующее напряжение, кВ. Задайте обе границы явно: номинал оборудования не является допустимым диапазоном. Это параметры следующего запуска; паспорт и уравнения не меняются.</p>
    <p className="dialog-intro">В проекте применённые границы сохраняются с расчётом в архиве. Настройки этого окна действуют до смены схемы или перезагрузки.</p>
    {!targets.length && <p role="status">Сначала выполните расчёт без границ: терминалы будут получены из его карты оборудования.</p>}
    <form className="scheme-form operating-limits-form" onSubmit={event=>{event.preventDefault();if(!error)onApply(parsed);}}>
      {rows.map((r,index)=><fieldset className="voltage-limit-row" key={index}>
        <legend>Граница {index+1}</legend>
        <label>Объект и терминал<select aria-label={`Объект и терминал ${index+1}`} value={r.target} onChange={e=>change(index,'target',e.target.value)}>
          {!options.has(r.target) && <option value={r.target}>Терминал {r.target} недоступен</option>}
          {targets.map(t=><option key={key(t)} value={key(t)}>{t.label}</option>)}
        </select></label>
        <label>Минимум, кВ<input aria-label={`Минимум ${index+1}, кВ`} type="number" step="any" value={r.min} onChange={e=>change(index,'min',e.target.value)} /></label>
        <label>Максимум, кВ<input aria-label={`Максимум ${index+1}, кВ`} type="number" step="any" value={r.max} onChange={e=>change(index,'max',e.target.value)} /></label>
        <button type="button" className="tool-btn" onClick={()=>setRows(previous=>previous.filter((_,i)=>i!==index))}>Убрать границу {index+1}</button>
      </fieldset>)}
      {error && <p role="alert">{error}</p>}
      <div className="dialog-actions">
        <button type="button" className="tool-btn" disabled={!targets.length||rows.length>=1000} onClick={()=>{const target=targets.find(t=>!rows.some(r=>r.target===key(t)))??targets[0];if(target)setRows(previous=>[...previous,{target:key(target),min:'',max:''}]);}}>Добавить границу</button>
        <button type="button" className="tool-btn" disabled={!rows.length} onClick={()=>setRows([])}>Очистить</button>
        <button type="button" className="tool-btn" onClick={onClose}>Отмена</button>
        <button className="tool-btn primary" disabled={!!error}>Применить к следующему расчёту</button>
      </div>
    </form>
  </Dialog>;
}
