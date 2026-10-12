/**
 * frontend/src/clients/httpWsRobotClient.js
 * 
 * HTTP & WEBSOCKET REMOTE ROBOT CLIENT FACADE (M9 / F9.1 - F9.6).
 */
import { z } from 'zod';
import { RobotStateSchema } from '@robot-hmi/contracts/robotState';
import {
    ListMapsResponseSchema,
    GetMapResponseSchema,
    GetActiveMappingSessionResponseSchema,
    StartMappingRequestSchema,
    FinishMappingRequestSchema,
    StartMappingResponseSchema,
    FinishMappingResponseSchema,
    JobSchema,
} from '@robot-hmi/contracts/mapping';
import {
    AcquireControlRequestSchema,
    AcquireControlResponseSchema,
    ReleaseControlRequestSchema,
    ReleaseControlResponseSchema,
    RequestStopRequestSchema,
    RequestStopResponseSchema,
    TeleopVelocityMessageSchema,
    ControlEventEnvelopeSchema,
    GetControlStateResponseSchema,
} from '@robot-hmi/contracts/control';
import {
    CameraQuerySchema,
    ListCamerasResponseSchema,
    GetCameraStreamResponseSchema,
} from '@robot-hmi/contracts/camera';
import {
    MapContextSchema,
    MapGridSnapshotSchema,
    ShallowMapGridEventEnvelopeSchema,
    MapGridEventEnvelopeSchema,
    preflightMapGrid,
} from '@robot-hmi/contracts/mapGrid';
import {
    ActivateMapRequestSchema,
    ActivateMapResponseSchema,
    PreviewRouteRequestSchema,
    PreviewRouteResponseSchema,
    SaveRouteRequestSchema,
    SaveRouteResponseSchema,
    ListRoutesQuerySchema,
    ListRoutesResponseSchema,
    MissionRequestSchema,
    CreateMissionResponseSchema,
    CancelMissionRequestSchema,
    GetMissionResponseSchema,
    GetActiveMissionResponseSchema,
    CancelMissionResponseSchema,
    MissionEventEnvelopeSchema,
    NavigationPathEnvelopeSchema,
    NavigationPathQuerySchema,
    preflightNavigationPath,
} from '@robot-hmi/contracts/mission';
import { createRemoteTransport } from './remoteTransport.js';
import { createVelocitySender } from './remoteVelocitySender.js';

const AuthUserSchema = z.object({
    id: z.string().trim().min(1).max(128),
    username: z.string().trim().min(1).max(64),
}).strict();
const AuthSessionResponseSchema = z.object({ user: AuthUserSchema }).strict();

export function createHttpWsRobotClient(options = {}) {
    const transport = createRemoteTransport(options);
    let user = null;
    let disposed = false;
    let activeLeaseId = null;
    let activeLeaseEpoch = null;
    let authGeneration = 0;
    let controlIntentGeneration = 0;

    transport.subscribeConnectionStatus(state => {
        if (state.status !== 'connected') {
            controlIntentGeneration++;
            activeLeaseId = null;
            activeLeaseEpoch = null;
        }
    });

    const velocitySender = createVelocitySender({
        requestSchema: TeleopVelocityMessageSchema,
        requireContext: () => {
            if (disposed || transport.getStatus() !== 'connected' ||
                activeLeaseEpoch !== transport.getConnectionEpoch()) {
                throw new Error('CONTROL_TRANSPORT_NOT_READY');
            }
            const socket = transport.getAppSocket();
            return {
                socket,
                leaseId: activeLeaseId,
                connectionEpoch: transport.getConnectionEpoch(),
            };
        },
    });

    function requireUsable() {
        if (disposed) {
            throw Object.assign(new Error('CLIENT_DISPOSED'), { code: 'CLIENT_DISPOSED' });
        }
    }

    function requireAuthenticated() {
        requireUsable();
        if (!user) {
            throw Object.assign(new Error('UNAUTHENTICATED'), { code: 'UNAUTHENTICATED' });
        }
        return user;
    }

    function getControlHeaders(required = false) {
        const hello = transport.getHelloData();
        if (!hello) {
            if (required) throw Object.assign(new Error('CONTROL_TRANSPORT_NOT_READY'),
                { code: 'CONTROL_TRANSPORT_NOT_READY' });
            return {};
        }
        return {
            'X-HMI-Connection-Id': hello.connectionId,
            'X-HMI-Owner-Token': hello.ownerToken,
        };
    }

    return {
        kind: 'remote',

        async login({ username, password }) {
            requireUsable();
            const generation = ++authGeneration;
            const res = AuthSessionResponseSchema.parse(await transport.request('/api/auth/login', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ username, password }),
            }));
            if (generation !== authGeneration || disposed) throw new Error('OPERATION_SUPERSEDED');
            user = res.user;
            transport.connectSockets();
            return { user: { ...user } };
        },

        async getSession() {
            requireUsable();
            const generation = ++authGeneration;
            try {
                const res = AuthSessionResponseSchema.parse(
                    await transport.request('/api/auth/session', { method: 'GET' }));
                if (generation !== authGeneration || disposed) throw new Error('OPERATION_SUPERSEDED');
                user = res.user;
                transport.connectSockets();
                return { user: { ...user } };
            } catch (err) {
                if (err.status === 401) {
                    if (generation !== authGeneration || disposed) {
                        throw Object.assign(new Error('OPERATION_SUPERSEDED', { cause: err }),
                            { code: 'OPERATION_SUPERSEDED' });
                    }
                    user = null;
                    activeLeaseId = null;
                    transport.resetSession();
                    return { user: null };
                }
                throw err;
            }
        },

        async logout() {
            requireUsable();
            const generation = ++authGeneration;
            // Stop local authority immediately; a failed HTTP logout must not
            // be presented as a successful session revocation.
            activeLeaseId = null;
            activeLeaseEpoch = null;
            controlIntentGeneration++;
            try {
                await transport.request('/api/auth/logout', { method: 'POST' });
                if (generation !== authGeneration || disposed) throw new Error('OPERATION_SUPERSEDED');
                user = null;
                transport.resetSession();
            } catch (error) {
                transport.disconnectSockets();
                throw error;
            }
        },

        async getRobotState() {
            requireAuthenticated();
            const res = await transport.request('/api/robot/state', { method: 'GET' });
            return RobotStateSchema.parse(res);
        },

        subscribeRobotState(listener) {
            requireAuthenticated();
            const generation = authGeneration;
            return transport.subscribeEvent('robot.state', event => {
                if (generation !== authGeneration) return;
                try {
                    listener(RobotStateSchema.parse(event.payload));
                } catch { /* ignore */ }
            });
        },

        async listMaps() {
            requireAuthenticated();
            const res = await transport.request('/api/maps', { method: 'GET' });
            return ListMapsResponseSchema.parse(res);
        },

        async getMap(id, revision) {
            requireAuthenticated();
            const suffix = revision ? `?revision=${encodeURIComponent(revision)}` : '';
            const res = await transport.request(`/api/maps/${encodeURIComponent(id)}${suffix}`, { method: 'GET' });
            return GetMapResponseSchema.parse(res);
        },

        async getMapGrid(context) {
            requireAuthenticated();
            context = MapContextSchema.parse(context);
            const params = new URLSearchParams();
            if (context.kind) params.set('kind', context.kind);
            if (context.mapId) params.set('mapId', context.mapId);
            if (context.mapRevision) params.set('mapRevision', context.mapRevision);
            if (context.mappingSessionId) params.set('mappingSessionId', context.mappingSessionId);

            const res = await transport.request(`/api/map-grid?${params.toString()}`, { method: 'GET' });
            preflightMapGrid(res);
            return MapGridSnapshotSchema.parse(res);
        },

        subscribeMapGrid(context, listener, options = {}) {
            requireAuthenticated();
            const checked = MapContextSchema.parse(context);
            const subId = options.subscriptionId ?? crypto.randomUUID();
            const generation = authGeneration;

            // Register before sending; a fast server may answer in the same tick.
            const unsub = transport.subscribeMapStream(event => {
                if (generation !== authGeneration || event.subscriptionId !== subId) return;
                try {
                    const shallow = ShallowMapGridEventEnvelopeSchema.parse(event);
                    if (shallow.type === 'map.grid') preflightMapGrid(shallow.payload);
                    const validated = MapGridEventEnvelopeSchema.parse(event);
                    const payloadContext = validated.payload.context;
                    if (JSON.stringify(payloadContext) !== JSON.stringify(checked)) return;
                    listener(validated);
                } catch { /* malformed/mismatched frame cannot reach the event gate */ }
            });

            transport.sendMapStream({
                version: 1,
                type: 'map.subscribe',
                subscriptionId: subId,
                context: checked,
            });

            return () => {
                unsub();
                transport.sendMapStream({
                    version: 1,
                    type: 'map.unsubscribe',
                    subscriptionId: subId,
                });
            };
        },

        async getActiveMappingSession() {
            requireAuthenticated();
            const res = await transport.request('/api/mapping/sessions/active', { method: 'GET' });
            return GetActiveMappingSessionResponseSchema.parse(res);
        },

        async startMapping(args) {
            requireAuthenticated();
            args = StartMappingRequestSchema.parse(args);
            const res = await transport.request('/api/mapping/start', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(args),
            });
            return StartMappingResponseSchema.parse(res);
        },

        async finishMapping(args) {
            requireAuthenticated();
            args = FinishMappingRequestSchema.parse(args);
            const res = await transport.request('/api/mapping/finish', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(args),
            });
            return FinishMappingResponseSchema.parse(res);
        },

        subscribeJobs(listener) {
            requireAuthenticated();
            const generation = authGeneration;
            return transport.subscribeEvent('job.updated', event => {
                if (generation !== authGeneration) return;
                try {
                    listener(JobSchema.parse(event.payload));
                } catch { /* ignore */ }
            });
        },

        async getJob(jobId) {
            requireAuthenticated();
            const res = await transport.request(`/api/jobs/${encodeURIComponent(jobId)}`, { method: 'GET' });
            return JobSchema.parse(res);
        },

        async activateMap(args) {
            requireAuthenticated();
            args = ActivateMapRequestSchema.parse(args);
            const res = await transport.request('/api/maps/activate', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(args),
            });
            return ActivateMapResponseSchema.parse(res);
        },

        async previewRoute(args) {
            requireAuthenticated();
            args = PreviewRouteRequestSchema.parse(args);
            const res = await transport.request('/api/routes/preview', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(args),
            });
            return PreviewRouteResponseSchema.parse(res);
        },

        async saveRoute(args) {
            requireAuthenticated();
            args = SaveRouteRequestSchema.parse(args);
            const res = await transport.request('/api/routes', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(args),
            });
            return SaveRouteResponseSchema.parse(res);
        },

        async listRoutes(query) {
            requireAuthenticated();
            query = ListRoutesQuerySchema.parse(query);
            const params = new URLSearchParams(query);
            const res = await transport.request(`/api/routes?${params.toString()}`, { method: 'GET' });
            return ListRoutesResponseSchema.parse(res);
        },

        async createMission(args) {
            requireAuthenticated();
            args = MissionRequestSchema.parse(args);
            const res = await transport.request('/api/missions', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(args),
            });
            return CreateMissionResponseSchema.parse(res);
        },

        async getMission(id) {
            requireAuthenticated();
            const res = await transport.request(`/api/missions/${encodeURIComponent(id)}`, { method: 'GET' });
            return GetMissionResponseSchema.parse(res);
        },

        async getActiveMission() {
            requireAuthenticated();
            const res = await transport.request('/api/missions/active', { method: 'GET' });
            return GetActiveMissionResponseSchema.parse(res);
        },

        async cancelMission(args) {
            requireAuthenticated();
            const { missionId, requestId } = CancelMissionRequestSchema.parse(args);
            const res = await transport.request(`/api/missions/${encodeURIComponent(missionId)}/cancel`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ missionId, requestId }),
            });
            return CancelMissionResponseSchema.parse(res);
        },

        subscribeMissions(listener) {
            requireAuthenticated();
            const generation = authGeneration;
            return transport.subscribeEvent('mission.updated', event => {
                if (generation !== authGeneration) return;
                try {
                    listener(MissionEventEnvelopeSchema.parse(event));
                } catch { /* ignore */ }
            });
        },

        subscribeNavigationPath(query, listener) {
            requireAuthenticated();
            const generation = authGeneration;
            const checked = NavigationPathQuerySchema.parse(query);
            return transport.subscribeEvent('navigation.path', event => {
                if (generation !== authGeneration) return;
                if (event.payload?.missionId === checked.missionId) {
                    try {
                        preflightNavigationPath(event);
                        listener(NavigationPathEnvelopeSchema.parse(event));
                    } catch { /* ignore */ }
                }
            });
        },

        async listCameras() {
            requireAuthenticated();
            const res = await transport.request('/api/cameras', { method: 'GET' });
            return ListCamerasResponseSchema.parse(res);
        },

        async getCameraStream(raw) {
            requireAuthenticated();
            const query = CameraQuerySchema.parse(raw);
            const res = await transport.request(`/api/cameras/${encodeURIComponent(query.cameraId)}/stream`, { method: 'GET' });
            return GetCameraStreamResponseSchema.parse(res);
        },

        async acquireControl(raw) {
            requireAuthenticated();
            const dto = AcquireControlRequestSchema.parse(raw);
            const epoch = transport.getConnectionEpoch();
            const intent = controlIntentGeneration;
            const headers = {
                'Content-Type': 'application/json',
                ...getControlHeaders(true),
            };
            try {
                const res = await transport.request('/api/control/lease', {
                    method: 'POST', headers, body: JSON.stringify(dto),
                });
                const parsed = AcquireControlResponseSchema.parse(res);
                if (intent !== controlIntentGeneration ||
                    epoch !== transport.getConnectionEpoch() ||
                    transport.getStatus() !== 'connected') {
                    throw Object.assign(new Error('OPERATION_SUPERSEDED'),
                        { code: 'OPERATION_SUPERSEDED' });
                }
                activeLeaseId = parsed.leaseId;
                activeLeaseEpoch = epoch;
                return parsed;
            } catch (error) {
                if (epoch === transport.getConnectionEpoch() &&
                    ['REQUEST_TIMEOUT', 'NETWORK_ERROR', 'OPERATION_SUPERSEDED'].includes(error.code)) {
                    // A POST may have committed despite a lost response. Query
                    // the same binding, then release any abandoned own lease.
                    try {
                        const snapshot = GetControlStateResponseSchema.parse(
                            await transport.request('/api/control/state', {
                                method: 'GET', headers: getControlHeaders(),
                            }));
                        const lease = snapshot.payload.lease;
                        if (lease) await transport.request('/api/control/release', {
                            method: 'POST', headers: { 'Content-Type': 'application/json',
                                ...getControlHeaders(true) },
                            body: JSON.stringify({ leaseId: lease.leaseId,
                                requestId: crypto.randomUUID() }),
                        });
                    } catch { /* Keep local drive disabled; server watchdog remains authoritative. */ }
                }
                throw error;
            }
        },

        async releaseControl(raw) {
            requireAuthenticated();
            const dto = ReleaseControlRequestSchema.parse(raw);
            const headers = {
                'Content-Type': 'application/json',
                ...getControlHeaders(true),
            };
            if (activeLeaseId === dto.leaseId) {
                controlIntentGeneration++;
                activeLeaseId = null;
                activeLeaseEpoch = null;
            }
            const res = await transport.request('/api/control/release', {
                method: 'POST', headers, body: JSON.stringify(dto),
            });
            return ReleaseControlResponseSchema.parse(res);
        },

        async requestStop(raw) {
            requireAuthenticated();
            const dto = RequestStopRequestSchema.parse(raw);
            activeLeaseId = null;
            activeLeaseEpoch = null;
            controlIntentGeneration++;
            const headers = { 'Content-Type': 'application/json' };
            const res = await transport.request('/api/control/stop', {
                method: 'POST',
                headers,
                body: JSON.stringify(dto),
            });
            return RequestStopResponseSchema.parse(res);
        },

        sendVelocity(raw) {
            requireAuthenticated();
            velocitySender(raw);
        },

        subscribeControl(listener) {
            requireAuthenticated();
            const generation = authGeneration;
            const eventTypes = [
                'control.snapshot',
                'control.granted',
                'control.heartbeat',
                'control.revoked',
                'control.stopConfirmed',
                'teleop.commandResult',
            ];
            const unsubs = eventTypes.map(type =>
                transport.subscribeEvent(type, event => {
                    if (generation !== authGeneration) return;
                    try {
                        listener(ControlEventEnvelopeSchema.parse(event));
                    } catch { /* ignore */ }
                })
            );
            return () => {
                for (const u of unsubs) u();
            };
        },

        async getControlState() {
            requireAuthenticated();
            const headers = getControlHeaders();
            const res = await transport.request('/api/control/state', {
                method: 'GET',
                headers,
            });
            return GetControlStateResponseSchema.parse(res);
        },

        subscribeConnectionStatus(listener) {
            requireUsable();
            return transport.subscribeConnectionStatus(listener);
        },

        get controlProfile() {
            return transport.getControlProfile();
        },

        dispose() {
            if (disposed) return;
            authGeneration++;
            disposed = true;
            activeLeaseId = null;
            user = null;
            transport.dispose();
        },
    };
}
