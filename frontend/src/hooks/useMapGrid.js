import { useEffect, useState } from 'react';
import { useRobotClient } from './useRobotClient.js';
import { createMapGridEventGate } from '../utils/mapGridEventGate.js';

export function useMapGrid(context, { expectedGeometry = null, expectedFrameId = null } = {}) {
  const client = useRobotClient();
  const [normalizedGrid, setNormalizedGrid] = useState(null);
  const [status, setStatus] = useState({
    state: 'waiting',
    sourceState: context?.kind === 'mapping' ? 'live' : 'saved',
    lastSourceUpdateAgeMs: null,
  });
  const [error, setError] = useState(null);

  // Khởi tạo Gate
  const [gate] = useState(() =>
    createMapGridEventGate({
      onSnapshot: (snap) => {
        setNormalizedGrid(snap);
        // Một snapshot hợp lệ trong cùng context là tín hiệu phục hồi thật.
        setError(null);
      },
      onStatus: (st) => setStatus(st),
      onError: (err) => setError(err),
      onValidSnapshot: () => setError(null),
    })
  );

  const contextKey = context
    ? context.kind === 'saved'
      ? `saved:${context.mapId}:${context.mapRevision}`
      : `mapping:${context.mappingSessionId}`
    : null;

  useEffect(() => {
    let active = true;

    if (!context) {
      queueMicrotask(() => {
        if (active) {
          setNormalizedGrid(null);
          setError(null);
          setStatus({ state: 'waiting', sourceState: 'saved', lastSourceUpdateAgeMs: null });
        }
      });
      return () => {
        active = false;
      };
    }

    const subId = `sub-gate-${Math.random().toString(36).substring(2, 9)}`;
    gate.setContext(context, subId, expectedGeometry || expectedFrameId || null);
    const generation = gate.getGeneration();

    queueMicrotask(() => {
      if (active) {
        setError(null);
        setStatus({
          state: 'waiting',
          sourceState: context.kind === 'mapping' ? 'live' : 'saved',
          lastSourceUpdateAgeMs: null,
        });
      }
    });

    client
      .getMapGrid(context)
      .then((payload) => {
        if (active) {
          gate.handleInitialResponse(generation, payload);
        }
      })
      .catch((err) => {
        if (active && gate.getGeneration() === generation) {
          if (err.code === 'MAP_NOT_READY') {
            return;
          }
          gate.handleInitialError(generation, err);
        }
      });

    const unsubscribe = client.subscribeMapGrid(
      context,
      (event) => {
        if (active) gate.handleEvent(generation, event);
      },
      { subscriptionId: subId }
    );

    return () => {
      active = false;
      unsubscribe();
    };
  }, [client, context, contextKey, gate, expectedGeometry, expectedFrameId]);

  return {
    normalizedGrid,
    status,
    error,
    generation: gate.getGeneration(),
  };
}
