import { z } from 'zod';

// Chỉ hai camera: front và rear
export const CameraIdSchema = z.enum(['front', 'rear']);

// Descriptor của một camera (info, không phải stream)
// refine: cameraId phải bằng position (không tráo nhãn)
export const CameraDescriptorSchema = z.object({
  cameraId: CameraIdSchema,
  label: z.string().min(1).max(80),
  position: CameraIdSchema,
  available: z.boolean(),
}).strict().refine(v => v.cameraId === v.position, {
  message: 'cameraId và position phải giống nhau.',
});

// Query để lấy stream (browser gửi lên)
export const CameraQuerySchema = z.object({
  cameraId: CameraIdSchema,
}).strict();

// Stream descriptor: discriminated union theo kind
// kind='file': mock — chỉ cho phép đúng 2 URL
// kind='webrtc': Chặng 9+, HTTPS only, grant token phải kèm expiry
export const CameraStreamDescriptorSchema = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('file'),
    cameraId: CameraIdSchema,
    url: z.enum(['/demo/front.mp4', '/demo/rear.mp4']),
  }).strict(),
  z.object({
    kind: z.literal('webrtc'),
    cameraId: CameraIdSchema,
    whepUrl: z.url().refine(v => new URL(v).protocol === 'https:',
      { message: 'WHEP URL phải dùng HTTPS.' }),
    grantToken: z.string().min(1).max(4096).optional(),
    expiresAt: z.iso.datetime().optional(),
  }).strict(),
]).superRefine((v, ctx) => {
  if (v.kind === 'file' && v.url !== `/demo/${v.cameraId}.mp4`) {
    ctx.addIssue({ code: 'custom', message: 'URL và cameraId không khớp.' });
  }
  if (v.kind === 'webrtc' && v.grantToken && !v.expiresAt) {
    ctx.addIssue({ code: 'custom', message: 'Grant token phải có expiresAt.' });
  }
});

export const ListCamerasResponseSchema = z.array(CameraDescriptorSchema)
  .max(2)
  .refine(items => new Set(items.map(i => i.cameraId)).size === items.length,
    { message: 'Không được trùng cameraId.' });

export const GetCameraStreamResponseSchema = CameraStreamDescriptorSchema;