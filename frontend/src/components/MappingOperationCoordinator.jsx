import { useEffect, useRef } from 'react';
import { useRobotClient } from '../hooks/useRobotClient.js';
import { useMappingWorkflowStore, handleIncomingJob } from '../state/mappingWorkflowStore.js';

export default function MappingOperationCoordinator({ children }) {
  const client = useRobotClient();
  const coordinatorEpochRef = useRef(0);

  useEffect(() => {
    coordinatorEpochRef.current += 1;
    const epoch = coordinatorEpochRef.current;
    let unsubJobs = null;
    useMappingWorkflowStore.getState().setReady(false);

    async function initCoordinator() {
      try {
        // 1. Subscribe jobs
        unsubJobs = client.subscribeJobs((job) => {
          if (epoch !== coordinatorEpochRef.current) return;
          handleIncomingJob(job, useMappingWorkflowStore);
        });

        // 2. Phục hồi phiên đang chạy
        const { session } = await client.getActiveMappingSession();
        if (epoch !== coordinatorEpochRef.current) return;

        // A null response is authoritative too: it must clear a mapping viewer
        // left behind by a previous user/coordinator mount.
        useMappingWorkflowStore.getState().replaceRecoveredSession(session);

        // 3. Reconcile tracked job nếu có
        const currentTracked = useMappingWorkflowStore.getState().trackedOperation;
        if (currentTracked?.jobId) {
          try {
            const fetched = await client.getJob(currentTracked.jobId);
            if (epoch === coordinatorEpochRef.current) {
              handleIncomingJob(fetched, useMappingWorkflowStore);
            }
          } catch (cause) {
            if (cause?.code === 'JOB_NOT_FOUND') {
              useMappingWorkflowStore.getState().clearMissingTrackedOperation(cause);
            } else {
              useMappingWorkflowStore.getState().markReconciliationPending(cause);
            }
          }
        }

        if (epoch === coordinatorEpochRef.current) {
          useMappingWorkflowStore.getState().setReady(true);
        }
      } catch (err) {
        if (epoch === coordinatorEpochRef.current) {
          useMappingWorkflowStore.getState().setLastError(err);
          useMappingWorkflowStore.getState().setReady(false);
        }
      }
    }

    initCoordinator();

    return () => {
      coordinatorEpochRef.current += 1;
      if (unsubJobs) unsubJobs();
      // The coordinator is mounted inside the authenticated route. Its unmount
      // is therefore the user/session boundary (including logout).
      useMappingWorkflowStore.getState().reset();
    };
  }, [client]);

  return children;
}
