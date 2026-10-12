import { z } from 'zod';

export const JobErrorSchema = z.object({
    code: z.string().min(1), message: z.string().min(1),
}).strict();

// Không thêm progress/updatedAt vào DTO Chặng 6. Status đã đủ cho demo.
const base = {
    jobId: z.string().min(1),
    createdAt: z.string().datetime(),
};
const point = z.object({
    x: z.number().finite(), y: z.number().finite(), yaw: z.number().finite(),
}).strict();

function variants(type, result) {
    const navigation = ['activate_map', 'preview_route'].includes(type);
    const fields = navigation
        ? { jobId: z.string().trim().min(1).max(128), createdAt: z.string().datetime() }
        : base;
    const error = navigation
        ? z.object({
            code: z.string().trim().min(1).max(128),
            message: z.string().trim().min(1).max(500),
        }).strict()
        : JobErrorSchema;
    return [
        z.object({
            ...fields, type: z.literal(type), status: z.enum(['accepted', 'running']),
            result: z.null(), error: z.null(),
        }).strict(),
        z.object({
            ...fields, type: z.literal(type), status: z.literal('completed'),
            result, error: z.null(),
        }).strict(),
        z.object({
            ...fields, type: z.literal(type), status: z.literal('failed'),
            result: z.null(), error,
        }).strict(),
    ];
}

export const [StartMappingJobPendingSchema, StartMappingJobCompletedSchema, StartMappingJobFailedSchema] =
    variants('start_mapping', z.object({ mappingSessionId: z.string().min(1) }).strict());
export const [FinishMappingJobPendingSchema, FinishMappingJobCompletedSchema, FinishMappingJobFailedSchema] =
    variants('finish_mapping', z.object({
        mapId: z.string().min(1), mapRevision: z.string().min(1),
    }).strict());
export const [ActivateMapJobPendingSchema, ActivateMapJobCompletedSchema, ActivateMapJobFailedSchema] =
    variants('activate_map', z.object({
        mapId: z.string().min(1), mapRevision: z.string().min(1), frameId: z.literal('map'),
    }).strict());
export const [PreviewRouteJobPendingSchema, PreviewRouteJobCompletedSchema, PreviewRouteJobFailedSchema] =
    variants('preview_route', z.object({
        mapId: z.string().min(1), mapRevision: z.string().min(1), frameId: z.literal('map'),
        label: z.literal('Đường minh họa'), path: z.array(point).min(1).max(2000),
    }).strict());

export const JobSchema = z.union([
    StartMappingJobPendingSchema,
    StartMappingJobCompletedSchema,
    StartMappingJobFailedSchema,
    FinishMappingJobPendingSchema,
    FinishMappingJobCompletedSchema,
    FinishMappingJobFailedSchema,
    ActivateMapJobPendingSchema,
    ActivateMapJobCompletedSchema,
    ActivateMapJobFailedSchema,
    PreviewRouteJobPendingSchema,
    PreviewRouteJobCompletedSchema,
    PreviewRouteJobFailedSchema,
]);

export const NavigationJobEventSchema = z.object({
    version: z.literal(1), type: z.literal('job.updated'),
    streamEpoch: z.string().min(1), sequence: z.number().int().safe().nonnegative(),
    sentAt: z.string().datetime(), payload: JobSchema,
}).strict();
