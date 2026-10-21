import { useEffect, useMemo, useState } from 'react';
import { useRobotClient } from './useRobotClient.js';

const ROS_CONTEXT = Object.freeze({ kind: 'ros' });

export function useRosMap() {
  const client = useRobotClient();
  const [metadata, setMetadata] = useState(null);
  const [error, setError] = useState(null);

  useEffect(() => {
    if (typeof client.getRosMap !== 'function') return undefined;
    let active = true;
    let timer;

    async function refresh() {
      try {
        const next = await client.getRosMap();
        if (!active) return;
        setMetadata(next);
        setError(null);
      } catch (cause) {
        if (!active) return;
        setError(cause);
      } finally {
        if (active) timer = setTimeout(refresh, 2000);
      }
    }
    void refresh();
    return () => { active = false; clearTimeout(timer); };
  }, [client]);

  const model = useMemo(() => metadata?.status === 'ready' ? {
    context: ROS_CONTEXT,
    gridRevision: metadata.revision,
    geometry: metadata.geometry,
    objectUrl: `/api/ros-map/image?revision=${metadata.revision}`,
    token: metadata.revision,
    onLoad: () => setError(null),
    onError: () => setError(new Error('Không tải được ảnh PNG của /map')),
  } : null, [metadata]);

  return { model, metadata, error };
}
