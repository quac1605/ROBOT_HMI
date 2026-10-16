import { useCallback, useLayoutEffect, useMemo, useRef, useState } from 'react';
import NavigationCameraPanel from './NavigationCameraPanel.jsx';
import { useControlStore } from '../../state/controlStore.js';

// Camera đang hiển thị cũng là nguồn health của manual guard. Chỉ subscribe
// selection ở wrapper; mỗi frame không làm render lại toàn bộ NavigationPage.
export default function NavigationDriveCamera() {
  const cameraId = useControlStore(state => state.selectedCameraId);
  const generation = useControlStore(state => state.selectedGeneration);
  const alive = useRef(false);
  const [mounted, setMounted] = useState(false);

  useLayoutEffect(() => {
    alive.current = true;
    const state = useControlStore.getState();
    // Retire health của lần vào trang trước trước khi mount reader đầu tiên.
    // Không mở WHEP với generation cũ rồi lập tức đóng/mở lại do reset effect.
    state.selectCamera(state.selectedCameraId);
    setMounted(true);
    return () => {
      alive.current = false;
      const current = useControlStore.getState();
      current.selectCamera(current.selectedCameraId);
    };
  }, []);

  const onSelect = useCallback(id => {
    if (!alive.current) return;
    const state = useControlStore.getState();
    if (state.selectedCameraId !== id) state.selectCamera(id);
  }, []);
  const onFrame = useCallback(({ cameraId: id, generation: nextGeneration, lastFrameAt }) => {
    if (alive.current) useControlStore.getState().onFrame(id, nextGeneration, lastFrameAt);
  }, []);
  const onFailure = useCallback(({ cameraId: id, generation: nextGeneration, message }) => {
    if (alive.current) useControlStore.getState().onCameraError(id, nextGeneration, { message });
  }, []);
  const controlCamera = useMemo(() => ({
    cameraId, generation, onSelect, onFrame, onFailure,
  }), [cameraId, generation, onSelect, onFrame, onFailure]);

  return mounted ? <NavigationCameraPanel controlCamera={controlCamera} /> : null;
}
