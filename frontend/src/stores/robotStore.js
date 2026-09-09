import { create } from 'zustand';

export const useRobotStore = create((set) => ({
  snapshot: null,
  lastReceivedAt: null, // Ghi lại thời điểm nhận gói tin theo đồng hồ monotonic trình duyệt
  error: null,
  accept: (snapshot) => set({ snapshot, lastReceivedAt: performance.now(), error: null }),
  reject: (error) => set({ error }),
  reset: () => set({ snapshot: null, lastReceivedAt: null, error: null }),
}));
