import { useEffect } from 'react';
import { useRobotClient } from '../hooks/useRobotClient.js';
import { createNavigationCoordinator } from '../utils/navigationCoordinator.js';
import { useMappingWorkflowStore } from '../state/mappingWorkflowStore.js';
import { useNavigationWorkflowStore } from '../state/navigationWorkflowStore.js';
import { useMissionStore } from '../state/missionStore.js';

export default function RobotOperationCoordinator({ children }) {
  const client = useRobotClient();
  useEffect(() => {
    const coordinator = createNavigationCoordinator(client);
    return () => {
      coordinator.dispose();
      // Auth boundary, không phải mỗi lần chuyển page.
      useMappingWorkflowStore.getState().reset();
      useNavigationWorkflowStore.getState().reset();
      useMissionStore.getState().clearMission();
    };
  }, [client]);
  return children;
}
