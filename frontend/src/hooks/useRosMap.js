import { useEffect, useMemo, useRef, useState } from 'react';
import { useRobotClient } from './useRobotClient.js';

const ROS_CONTEXT = Object.freeze({ kind: 'ros' });
const POLL_MS = 1000;

export function useRosMap() {
  const client = useRobotClient();
  const [metadata, setMetadata] = useState(null);
  const [metadataError, setMetadataError] = useState(null);
  const [imageError, setImageError] = useState(null);
  const [imageRetry, setImageRetry] = useState(0);
  const imageRetryTimer = useRef(null);
  const currentRevision = metadata?.status === 'ready' ? metadata.revision : null;
  const revisionRef = useRef(currentRevision);

  useEffect(() => {
    if (typeof client.getRosMap !== 'function') return undefined;
    let active = true;
    let timer;
    let inFlight = false;

    async function refresh() {
      if (inFlight) return;
      inFlight = true;
      try {
        const next = await client.getRosMap();
        if (!active) return;
        setMetadata(next);
        setMetadataError(null);
      } catch (cause) {
        if (!active) return;
        setMetadataError(cause);
      } finally {
        inFlight = false;
        if (active) timer = setTimeout(refresh, POLL_MS);
      }
    }
    function refreshOnFocus() {
      if (document.visibilityState === 'hidden') return;
      clearTimeout(timer);
      void refresh();
    }
    void refresh();
    document.addEventListener('visibilitychange', refreshOnFocus);
    window.addEventListener('focus', refreshOnFocus);
    return () => {
      active = false;
      clearTimeout(timer);
      document.removeEventListener('visibilitychange', refreshOnFocus);
      window.removeEventListener('focus', refreshOnFocus);
    };
  }, [client]);

  useEffect(() => {
    revisionRef.current = currentRevision;
    clearTimeout(imageRetryTimer.current);
    imageRetryTimer.current = null;
    setImageRetry(0);
    setImageError(null);
  }, [currentRevision]);

  useEffect(() => () => clearTimeout(imageRetryTimer.current), []);

  const model = useMemo(() => metadata?.status === 'ready' ? {
    context: ROS_CONTEXT,
    gridRevision: metadata.revision,
    geometry: metadata.geometry,
    objectUrl: `/api/ros-map/image?revision=${metadata.revision}&retry=${imageRetry}`,
    token: metadata.revision,
    onLoad: () => {
      if (revisionRef.current !== metadata.revision) return;
      clearTimeout(imageRetryTimer.current);
      imageRetryTimer.current = null;
      setImageError(null);
    },
    onError: () => {
      if (revisionRef.current !== metadata.revision) return;
      setImageError(new Error('Không tải được ảnh PNG của /map; đang thử lại'));
      if (!imageRetryTimer.current) {
        imageRetryTimer.current = setTimeout(() => {
          imageRetryTimer.current = null;
          setImageRetry(value => value + 1);
        }, POLL_MS);
      }
    },
  } : null, [metadata, imageRetry]);

  return { model, metadata, error: metadataError || imageError };
}
