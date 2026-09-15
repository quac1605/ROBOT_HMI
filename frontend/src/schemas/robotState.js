import { z } from 'zod';

const finite = z.number().finite();
export const RobotStateSchema = z.object({
  robotId: z.string(),
  mode: z.enum(['idle', 'mapping', 'localizing', 'navigating', 'teleop', 'fault']),
  rosConnected: z.boolean(),
  localization: z.object({
    status: z.enum(['tracking', 'lost', 'unknown']),
    reason: z.string().nullable(),
  }),
  pose: z.object({
    frameId: z.string().trim().min(1).max(128),
    x: finite,
    y: finite,
    yaw: finite,
  }).strict().nullable(),
  poseSourceUpdateAgeMs: finite.nonnegative().nullable(),
  velocity: z.object({ linearX: finite, angularZ: finite }).nullable(),
  batteryPercent: finite.min(0).max(100).nullable(),
  physicalEstopActive: z.boolean().nullable(),
  motionInhibited: z.boolean().optional(),
  motionInhibitReason: z.string().nullable().optional(),
  receivedAt: z.string(),
  activeMap: z.object({
    id: z.string().min(1),
    revision: z.string().min(1),
  }).nullable(),
  activeMappingSessionId: z.string().min(1).nullable(),
}).strict();
