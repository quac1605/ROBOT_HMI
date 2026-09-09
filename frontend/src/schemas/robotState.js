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
  pose: z.object({ frameId: z.string(), x: finite, y: finite, yaw: finite }).nullable(),
  velocity: z.object({ linearX: finite, angularZ: finite }).nullable(),
  batteryPercent: finite.min(0).max(100).nullable(),
  physicalEstopActive: z.boolean().nullable(),
  receivedAt: z.string(),
}).passthrough();