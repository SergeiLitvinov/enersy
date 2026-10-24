import { useEffect, useState } from 'react';
import { getComputeBackends, type ComputeBackendId } from '../../../api/compute-backends';

export function useComputeBackends() {
  const [ids, setIds] = useState<ComputeBackendId[]>([]);
  const [message, setMessage] = useState('Проверка движков…');
  const [revision, setRevision] = useState(0);
  useEffect(() => {
    const controller = new AbortController();
    setIds([]); setMessage('Проверка движков…');
    getComputeBackends(controller.signal).then(available => {
      if (!controller.signal.aborted) { setIds(available); setMessage(''); }
    }).catch((error: unknown) => {
      if (!controller.signal.aborted) setMessage(error instanceof Error ? error.message : 'Движки недоступны');
    });
    return () => controller.abort();
  }, [revision]);
  return { ids, message, reload: () => setRevision(value => value + 1) };
}
