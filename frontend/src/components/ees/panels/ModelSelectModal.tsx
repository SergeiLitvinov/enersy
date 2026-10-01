import { useEffect, useState } from 'react';
import * as api from '../../../api/ees-api';
import { Dialog } from '../../ui/Dialog';
import { Icon } from '../../ui/Icon';
interface ModelSelectModalProps {
  componentType: { id: number; code: string; name: string };
  onConfirm: (equipmentModelId: number | null) => Promise<void>;
  onCancel: () => void;
}
export function ModelSelectModal({ componentType, onConfirm, onCancel }: ModelSelectModalProps) {
  const [models, setModels] = useState<api.EquipmentModel[]>([]); const [selected, setSelected] = useState<number | null>(null);
  const [loading, setLoading] = useState(true); const [busy, setBusy] = useState(false); const [error, setError] = useState(''); const [retry, setRetry] = useState(0);
  useEffect(() => { let active = true; setLoading(true); setError('');
    api.getEquipmentModels(componentType.code).then(list => { if (active) setModels(list); }).catch(() => { if (active) setError('Не удалось загрузить каталог моделей. Повторите запрос.'); }).finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, [componentType.code, retry]);
  async function confirm() {
    setBusy(true); setError('');
    try { await onConfirm(selected); }
    catch (e) { setError(e instanceof Error ? e.message : 'Не удалось сохранить оборудование. Изменения отменены.'); }
    finally { setBusy(false); }
  }
  return <Dialog title={`Добавить: ${componentType.name}`} onClose={onCancel} closeDisabled={busy}>
    <p className="dialog-intro">Выберите паспортный вариант или задайте параметры самостоятельно. Наличие паспорта в каталоге не подтверждает поддержку его расчётной модели.</p>
    {error && <div className="calculation-error" role="alert"><Icon name="alert" /><p>{error}</p></div>}
    {loading ? <p className="modal-loading">Загрузка каталога…</p> : <div className="model-list">
      <label className={`model-item ${selected === null ? 'selected' : ''}`}><input type="radio" name="equipment-model" checked={selected === null} onChange={() => setSelected(null)} /><span className="model-item-name">Задать параметры самостоятельно</span><span className="model-item-desc">Обязательные физические параметры необходимо заполнить перед расчётом.</span></label>
      {models.map(model => <label key={model.id} className={`model-item ${selected === model.id ? 'selected' : ''}`}><input type="radio" name="equipment-model" checked={selected === model.id} onChange={() => setSelected(model.id)} /><span className="model-item-name">{model.model_name}</span><span className="model-item-mfr">{model.manufacturer}</span><span className="model-item-desc">{model.description}</span></label>)}
    </div>}
    <div className="dialog-actions">{error && <button className="tool-btn" onClick={() => setRetry(n => n + 1)} disabled={busy}><Icon name="reset" />Повторить</button>}<button className="tool-btn" onClick={onCancel} disabled={busy}>Отмена</button><button className="tool-btn primary" onClick={confirm} disabled={loading || busy || Boolean(error)}><Icon name="plus" />{busy ? 'Добавление…' : 'Добавить на схему'}</button></div>
  </Dialog>;
}
