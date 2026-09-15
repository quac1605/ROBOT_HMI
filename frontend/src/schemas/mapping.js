import { z } from 'zod';

const RequestIdSchema = z.string().trim().min(1).max(128);
const MapNameSchema = z.string().trim().min(1).max(120);

export const StartMappingRequestSchema = z
  .object({
    name: MapNameSchema,
    requestId: RequestIdSchema,
  })
  .strict();

export const FinishMappingRequestSchema = z
  .object({
    mappingSessionId: z.string().trim().min(1).max(128),
    name: MapNameSchema,
    requestId: RequestIdSchema,
  })
  .strict();

export const MapAssetSchema = z
  .object({
    type: z.enum(['grid_json', 'yaml_meta', 'preview_png']),
    source: z.literal('mock'),
    storage: z.literal('memory'),
    status: z.enum(['pending', 'ready']),
  })
  .strict();

export const MapCapabilitiesSchema = z
  .object({
    hasOccupancyGrid: z.boolean(),
    hasSlamState: z.literal(false), // Nhất quán: mock Chặng 6 không có SLAM state file
    canResumeMapping: z.boolean(),
    canLocalize: z.boolean(),
    canNavigate: z.boolean(),
  })
  .strict();

export const MapMetadataSchema = z
  .object({
    id: z.string().min(1),
    revision: z.string().min(1),
    name: z.string().min(1),
    status: z.enum(['creating', 'ready', 'failed']),
    frameId: z.string().trim().min(1).max(128),
    width: z.number().int().positive(),
    height: z.number().int().positive(),
    resolution: z.number().positive(),
    origin: z
      .object({
        x: z.number().finite(),
        y: z.number().finite(),
        yaw: z.number().finite(),
      })
      .strict(),
    assets: z.array(MapAssetSchema),
    capabilities: MapCapabilitiesSchema,
    createdAt: z.string().datetime(),
  })
  .strict();

export const MappingSessionSchema = z
  .object({
    mappingSessionId: z.string().min(1),
    name: z.string().min(1),
    status: z.enum(['starting', 'mapping', 'finishing', 'save_failed']),
    startedAt: z.string().datetime(),
  })
  .strict();

const JobErrorSchema = z
  .object({
    code: z.string().min(1),
    message: z.string().min(1),
  })
  .strict();

// Discriminated union kết quả Job theo type và status invariant
const StartMappingJobPendingSchema = z
  .object({
    jobId: z.string().min(1),
    type: z.literal('start_mapping'),
    status: z.enum(['accepted', 'running']),
    result: z.null(),
    error: z.null(),
    createdAt: z.string().datetime(),
  })
  .strict();

const StartMappingJobCompletedSchema = z
  .object({
    jobId: z.string().min(1),
    type: z.literal('start_mapping'),
    status: z.literal('completed'),
    result: z.object({ mappingSessionId: z.string().min(1) }).strict(),
    error: z.null(),
    createdAt: z.string().datetime(),
  })
  .strict();

const StartMappingJobFailedSchema = z
  .object({
    jobId: z.string().min(1),
    type: z.literal('start_mapping'),
    status: z.literal('failed'),
    result: z.null(),
    error: JobErrorSchema,
    createdAt: z.string().datetime(),
  })
  .strict();

const FinishMappingJobPendingSchema = z
  .object({
    jobId: z.string().min(1),
    type: z.literal('finish_mapping'),
    status: z.enum(['accepted', 'running']),
    result: z.null(),
    error: z.null(),
    createdAt: z.string().datetime(),
  })
  .strict();

const FinishMappingJobCompletedSchema = z
  .object({
    jobId: z.string().min(1),
    type: z.literal('finish_mapping'),
    status: z.literal('completed'),
    result: z.object({ mapId: z.string().min(1), mapRevision: z.string().min(1) }).strict(),
    error: z.null(),
    createdAt: z.string().datetime(),
  })
  .strict();

const FinishMappingJobFailedSchema = z
  .object({
    jobId: z.string().min(1),
    type: z.literal('finish_mapping'),
    status: z.literal('failed'),
    result: z.null(),
    error: JobErrorSchema,
    createdAt: z.string().datetime(),
  })
  .strict();

export const JobSchema = z.union([
  StartMappingJobPendingSchema,
  StartMappingJobCompletedSchema,
  StartMappingJobFailedSchema,
  FinishMappingJobPendingSchema,
  FinishMappingJobCompletedSchema,
  FinishMappingJobFailedSchema,
]);

// Schemas xác thực response tại biên RobotClient
export const ListMapsResponseSchema = z.array(MapMetadataSchema);
export const GetMapResponseSchema = MapMetadataSchema;
export const GetActiveMappingSessionResponseSchema = z
  .object({
    session: MappingSessionSchema.nullable(),
  })
  .strict();

export const StartMappingResponseSchema = z
  .object({
    mappingSessionId: z.string().min(1),
    jobId: z.string().min(1),
    status: z.literal('accepted'),
  })
  .strict();

export const FinishMappingResponseSchema = z
  .object({
    jobId: z.string().min(1),
    status: z.literal('accepted'),
  })
  .strict();

