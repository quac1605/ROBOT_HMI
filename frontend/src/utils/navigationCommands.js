import { useMissionStore } from '../state/missionStore.js';
import { useNavigationWorkflowStore } from '../state/navigationWorkflowStore.js';
import { errorDto } from './navigationPolicy.js';
import { isMissionTerminal } from './missionState.js';

function uncertain(error) {
    return error?.name !== 'ZodError' && (error?.outcomeUnknown === true || !error?.code ||
        ['NETWORK_ERROR', 'REQUEST_TIMEOUT', 'TIMEOUT', 'HTTP_TIMEOUT', 'CONNECTION_LOST']
            .includes(error.code));
}

// Payload được tạo/lưu trước khi await. Retry luôn dùng lại chính payload đó.
export async function sendMissionIntent(client, request, retry = false) {
    const store = useMissionStore;
    const generation = store.getState().generation;
    store.getState().beginRequest('missionRequest', request);
    try {
        if (retry) {
            const { mission } = await client.getActiveMission();
            if (generation !== store.getState().generation) return;
            if (mission?.requestId === request.requestId) {
                store.getState().updateRequest('missionRequest', request.requestId,
                    { missionId: mission.missionId, status: 'acknowledged' });
                store.getState().selectMission(mission.missionId);
                store.getState().requestRecovery();
                return;
            }
        }
        // Không tìm thấy active chưa chứng minh POST cũ thất bại:
        // replay cùng requestId có thể tìm lại mission đã terminal.
        const response = await client.createMission(request);
        if (generation !== store.getState().generation) return;
        store.getState().updateRequest('missionRequest', request.requestId,
            { missionId: response.missionId, status: 'acknowledged' });
        store.getState().selectMission(response.missionId);
        store.getState().requestRecovery();
    } catch (error) {
        if (generation !== store.getState().generation) return;
        const known = Object.values(store.getState().missionsById).find(m => m.requestId === request.requestId);
        store.getState().updateRequest('missionRequest', request.requestId, known
            ? { missionId: known.missionId, status: 'acknowledged', error: null }
            : { status: uncertain(error) ? 'uncertain' : 'failed', error: errorDto(error) });
    }
}

export async function cancelMissionIntent(client, request) {
    const store = useMissionStore;
    const generation = store.getState().generation;
    store.getState().beginRequest('cancelRequest', request);
    try {
        await client.cancelMission(request);
        if (generation !== store.getState().generation) return;
        store.getState().updateRequest('cancelRequest', request.requestId, { status: 'acknowledged' });
        store.getState().requestRecovery();
    } catch (error) {
        if (generation !== store.getState().generation) return;
        const known = store.getState().missionsById[request.missionId];
        store.getState().updateRequest('cancelRequest', request.requestId,
            known && isMissionTerminal(known.status)
                ? { status: 'acknowledged', error: null }
                : { status: uncertain(error) ? 'uncertain' : 'failed', error: errorDto(error) });
    }
}

export async function sendJobIntent(client, kind, request) {
    const store = useNavigationWorkflowStore;
    const generation = store.getState().generation;
    const existing = store.getState()[kind];
    if (existing?.request.requestId === request.requestId) {
        store.getState().updateOperation(kind, request.requestId, { status: 'sending', error: null });
    } else store.getState().beginOperation(kind, request);
    try {
        const response = kind === 'activation' ? await client.activateMap(request) : await client.previewRoute(request);
        if (generation !== store.getState().generation) return;
        store.getState().bindJob(kind, request.requestId, response.jobId);
        const job = await client.getJob(response.jobId);
        if (generation !== store.getState().generation) return;
        store.getState().recordJob(job);
    } catch (error) {
        if (generation !== store.getState().generation) return;
        const tracked = store.getState()[kind];
        const known = tracked?.request.requestId === request.requestId
            ? store.getState().jobsById[tracked.jobId] : null;
        if (known) {
            // An authoritative event already identified this job. A later HTTP
            // failure must not regress completed/failed to uncertain/pending.
            store.getState().recordJob(known);
            return;
        }
        store.getState().updateOperation(kind, request.requestId,
            { status: uncertain(error) ? 'uncertain' : 'failed', error: errorDto(error) });
    }
}
