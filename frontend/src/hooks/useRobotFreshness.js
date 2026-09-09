import { useEffect, useState } from 'react';
import { useRobotStore } from '../stores/robotStore.js';

export function useRobotFreshness(staleAfterMs = 2000) {
  const lastReceivedAt = useRobotStore((state) => state.lastReceivedAt);
  const [now, setNow] = useState(() => performance.now());

  useEffect(() => {
    // Chạy một đồng hồ nhịp 250ms để tính toán độ trễ thời gian thực
    const timer = setInterval(() => setNow(performance.now()), 250);
    return () => clearInterval(timer);
  }, []);

  const ageMs = lastReceivedAt === null ? null : Math.max(0, now - lastReceivedAt);
  return {
    ageMs,
    stale: ageMs === null || ageMs > staleAfterMs,
  };
}
