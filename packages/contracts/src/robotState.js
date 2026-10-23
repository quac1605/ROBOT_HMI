import { z } from 'zod';

const finite = z.number().finite();
const PoseSchema = z.object({
  frameId: z.string().trim().min(1).max(128),
  x: finite,
  y: finite,
  yaw: finite,
}).strict();
export const RobotStateSchema = z.object({
  robotId: z.string(),
  mode: z.enum(['idle', 'mapping', 'localizing', 'navigating', 'teleop', 'fault']),
  rosConnected: z.boolean(),
  localization: z.object({
    status: z.enum(['tracking', 'lost', 'unknown']),
    reason: z.string().nullable(),
  }).strict(),
  pose: PoseSchema.nullable(),
  // Pose in the active ROS /map frame after TF. Null until /odom and TF are fresh.
  mapPose: PoseSchema.nullable().default(null),
  poseSourceUpdateAgeMs: finite.nonnegative().nullable(),
  velocity: z.object({ linearX: finite, angularZ: finite }).strict().nullable(),
  batteryPercent: finite.min(0).max(100).nullable(),
  physicalEstopActive: z.boolean().nullable(),
  motionInhibited: z.boolean(),
  motionInhibitReason: z.string().nullable(),
  receivedAt: z.string(),
  activeMap: z.object({
    id: z.string().min(1),
    revision: z.string().min(1),
  }).strict().nullable(),
  activeMappingSessionId: z.string().min(1).nullable(),
  activeMissionId: z.string().min(1).max(128).nullable(),
}).strict();
