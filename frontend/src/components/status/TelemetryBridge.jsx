import { useEffect } from 'react';
import { useAuth } from '../../auth/AuthContext.js';
import { robotClient } from '../../clients/index.js';
import { RobotStateSchema } from '../../schemas/robotState.js';
import { useRobotStore } from '../../stores/robotStore.js';

export default function TelemetryBridge() {
  const { status } = useAuth();

  useEffect(() => {
    const store = useRobotStore.getState();
    store.reset();

    // Chỉ kết nối lắng nghe telemetry khi người dùng đã đăng nhập thành công
    if (status !== 'authenticated') return undefined;

    const unsubscribe = robotClient.subscribeRobotState((message) => {
      const result = RobotStateSchema.safeParse(message);
      if (result.success) {
        store.accept(result.data);
      } else {
        store.reject('Dữ liệu telemetry không đúng chuẩn Schema');
      }
    });

    return () => {
      unsubscribe();
      store.reset();
    };
  }, [status]);

  return null; // Component chạy ngầm, không render giao diện
}
