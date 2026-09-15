import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { createOccupancyRasterController } from '../utils/occupancyRasterController.js';
import { defaultRasterRuntime } from '../utils/rasterRuntime.js';

export function useOccupancyRaster(normalizedGrid, runtime = defaultRasterRuntime) {
  const controllerRef = useRef(null);
  const [presentation, setPresentation] = useState(null);
  const [rasterError, setRasterError] = useState(null);

  useEffect(() => {
    const controller = createOccupancyRasterController({
      runtime,
      onPublish(next) {
        setPresentation(next ? { ...next, owner: controller } : null);
        setRasterError(null);
      },
      onError: setRasterError,
    });
    controllerRef.current = controller;

    return () => {
      if (controllerRef.current === controller) controllerRef.current = null;
      controller.dispose();
    };
  }, [runtime]);

  useEffect(() => {
    controllerRef.current?.updateGrid(normalizedGrid ?? null);
  }, [normalizedGrid, runtime]);

  useLayoutEffect(() => {
    if (presentation && !presentation.raster) {
      presentation.owner.acknowledgeCleared();
    }
  }, [presentation]);

  const raster = useMemo(() => {
    if (!presentation?.raster) return null;
    const { owner, raster: value } = presentation;
    return {
      ...value,
      onLoad: () => owner.acknowledgeLoaded(value.token),
      onError: (event) => owner.acknowledgeImageError(value.token, event),
    };
  }, [presentation]);

  return { raster, rasterError };
}
