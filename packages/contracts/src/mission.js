import { z } from 'zod';

const finite = z.number().finite();
const id = z.string().trim().min(1).max(128);
export const RequestIdSchema = z.string().uuid();

export const MissionPoseSchema = z.object({
  frameId: z.literal('map'),
  x: finite,
  y: finite,
  yaw: finite,
}).strict();

export const MissionKindSchema = z.enum([
  'navigate_to_pose',
  'navigate_through_poses',
]);

function validateKindAndPoses(value, context) {
  const count = value.poses.length;
  if ((value.kind === 'navigate_to_pose' && count !== 1) ||
      (value.kind === 'navigate_through_poses' && count < 2)) {
    context.addIssue({ code: 'custom', path: ['poses'], message: 'Số pose không khớp loại mission.' });
  }
}

export const MissionRequestSchema = z.object({
  requestId: RequestIdSchema,
  kind: MissionKindSchema,
  mapId: id,
  mapRevision: id,
  poses: z.array(MissionPoseSchema).min(1).max(100),
}).strict().superRefine(validateKindAndPoses);

export const MissionErrorSchema = z.object({
  code: id,
  message: z.string().trim().min(1).max(500),
}).strict();

export const MissionSchema = z.object({
  missionId: id,
  requestId: RequestIdSchema,
  kind: MissionKindSchema,
  mapId: id,
  mapRevision: id,
  poses: z.array(MissionPoseSchema).min(1).max(100),
  status: z.enum([
    'accepted',
    'executing',
    'canceling',
    'succeeded',
    'failed',
    'canceled',
  ]),
  currentPoseIndex: z.number().int().nonnegative().nullable(),
  distanceRemainingM: finite.nonnegative().nullable(),
  error: MissionErrorSchema.nullable(),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
}).strict().superRefine((value, context) => {
  validateKindAndPoses(value, context);
  if (value.currentPoseIndex !== null && value.currentPoseIndex >= value.poses.length) {
    context.addIssue({ code: 'custom', path: ['currentPoseIndex'], message: 'Index vượt số pose của mission.' });
  }
  if ((value.status === 'failed') !== (value.error !== null)) {
    context.addIssue({ code: 'custom', path: ['error'], message: 'Mission failed phải có lỗi; trạng thái khác không mang lỗi terminal.' });
  }
});

export const CreateMissionResponseSchema = z.object({
  missionId: id,
  status: z.literal('accepted'),
}).strict();

export const GetMissionResponseSchema = MissionSchema;

export const GetActiveMissionResponseSchema = z.object({
  mission: MissionSchema.nullable(),
}).strict().refine(value => !value.mission || ['accepted', 'executing', 'canceling'].includes(value.mission.status),
  { path: ['mission'], message: 'getActiveMission không được trả mission terminal.' });

export const ListRoutesQuerySchema = z.object({ mapId: id, mapRevision: id }).strict();
export const NavigationPathQuerySchema = z.object({ missionId: id }).strict();

export const CancelMissionRequestSchema = z.object({
  missionId: id,
  requestId: RequestIdSchema,
}).strict();

export const CancelMissionResponseSchema = z.object({
  missionId: id,
  status: z.enum(['canceling', 'succeeded', 'failed', 'canceled']),
}).strict();

export const MissionEventEnvelopeSchema = z.object({
  version: z.literal(1),
  type: z.literal('mission.updated'),
  streamEpoch: id,
  sequence: z.number().int().safe().nonnegative(),
  sentAt: z.string().datetime(),
  payload: MissionSchema,
}).strict();

export const NavigationPathPoseSchema = z.object({
  x: finite,
  y: finite,
  yaw: finite,
}).strict();

export const NavigationPathPayloadSchema = z.object({
  missionId: id,
  mapId: id,
  mapRevision: id,
  frameId: z.literal('map'),
  kind: z.literal('planned'),
  poses: z.array(NavigationPathPoseSchema).min(1).max(2000),
}).strict();

export const NavigationPathEnvelopeSchema = z.object({
  version: z.literal(1),
  type: z.literal('navigation.path'),
  streamEpoch: id,
  sequence: z.number().int().safe().nonnegative(),
  sentAt: z.string().datetime(),
  payload: NavigationPathPayloadSchema,
}).strict();

export const PreviewRouteRequestSchema = z.object({
  requestId: RequestIdSchema,
  mapId: id,
  mapRevision: id,
  poses: z.array(MissionPoseSchema).min(1).max(100),
}).strict();

export const SaveRouteRequestSchema = PreviewRouteRequestSchema.extend({
  name: z.string().trim().min(1).max(120),
}).strict();

export const RouteSchema = z.object({
  routeId: id,
  name: z.string().trim().min(1).max(120),
  mapId: id,
  mapRevision: id,
  poses: z.array(MissionPoseSchema).min(1).max(100),
  createdAt: z.string().datetime(),
}).strict();

export const ActivateMapRequestSchema = z.object({
  mapId: id,
  mapRevision: id,
  requestId: RequestIdSchema,
}).strict();

export const ActivateMapResponseSchema = z.object({
  jobId: id,
  status: z.literal('accepted'),
}).strict();

export const PreviewRouteResponseSchema = ActivateMapResponseSchema;
export const SaveRouteResponseSchema = RouteSchema;
export const ListRoutesResponseSchema = z.array(RouteSchema);

// Preflight check để chặn payload planned path vượt quá 2000 điểm hoặc 256 KiB
export function preflightNavigationPath(raw) {
  const count = raw?.payload?.poses?.length;
  if (!Number.isInteger(count) || count < 1 || count > 2000) {
    throw Object.assign(new Error('Planned path không hợp lệ'), {
      code: 'PATH_TOO_LARGE',
    });
  }

  const bytes = new TextEncoder().encode(JSON.stringify(raw)).byteLength;
  if (bytes > 256 * 1024) {
    throw Object.assign(new Error('Planned path vượt 256 KiB'), {
      code: 'PATH_TOO_LARGE',
    });
  }
}
