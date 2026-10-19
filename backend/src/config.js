/**
 * backend/src/config.js
 * 
 * NẠP VÀ KIỂM TRA TÍNH HỢP LỆ CỦA BIẾN MÔI TRƯỜNG (M3 - FAIL FAST).
 * 
 * Nguyên tắc an toàn:
 * 1. Fail-fast: Nếu thiếu hoặc sai bất kỳ biến nào, throw Error ngay lập tức lúc khởi động.
 * 2. Sanitize: Bắt ZodError và chỉ báo tên field lỗi, TUYỆT ĐỐI không in raw process.env
 *    (tránh lộ mật khẩu database hay session secret trong log).
 * 3. Chống secret yếu: Chặn các session secret ví dụ đã công bố trong tài liệu.
 * 4. Adapter mock: Khóa cứng ROBOT_ADAPTER='mock', không tự suy đoán sang real hardware.
 */
import { z } from 'zod';

const ConfigShape = z.object({
    NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
    HOST: z.string().default('127.0.0.1'),
    PORT: z.coerce.number().int().min(1).max(65535).default(3001),
    APP_ORIGIN: z.string().url(),
    DATABASE_URL: z.string().url(),
    // Session secret tối thiểu 64 hex characters (32 bytes entropy)
    SESSION_SECRET: z.string().regex(/^[a-fA-F0-9]{64,128}$/),
    ROBOT_ADAPTER: z.literal('mock').default('mock'),
    // Camera may be real while all motion and mapping still use MockRosAdapter.
    CAMERA_MEDIA_MODE: z.enum(['demo', 'ros']).default('demo'),
    CAMERA_WHEP_BASE_URL: z.string().url().optional(),
    DATA_DIR: z.string().min(1),
    TRUST_LOOPBACK_PROXY: z.enum(['true', 'false']).default('false'),
    // rosbridge của ROS 2: đọc trạng thái robot (/odom, /cmd_in) và phát /cmd_out trên cùng
    // một kết nối. Bỏ trống thì không nối ROS, giữ nguồn mock.
    ROSBRIDGE_URL: z.preprocess(
        value => (value === '' ? undefined : value),
        z.string().regex(/^wss?:\/\/[^\s]+$/).optional(),
    ),
});

// Chuỗi secret ví dụ đã xuất hiện trong tài liệu thiết kế (phải chặn)
const PUBLISHED_EXAMPLE_SECRET = 'c5f78b824a733e88a38914fc2ee9d44399856992ee6c052ef7bb78540a735f6a';

export function loadConfig(env = process.env) {
    // Chỉ lấy đúng các key app quan tâm, bỏ qua các biến OS ngẫu nhiên khác
    const raw = Object.fromEntries(
        Object.keys(ConfigShape.shape).map(key => [key, env[key]])
    );

    let parsed;
    try {
        parsed = ConfigShape.parse(raw);
    } catch (error) {
        if (error instanceof z.ZodError) {
            // Chỉ in tên các trường bị lỗi, không in giá trị (giá trị có thể chứa mật khẩu DB)
            const invalidFields = error.issues.map(i => `${i.path.join('.')}: ${i.message}`).join('; ');
            throw new Error(`CONFIG_VALIDATION_FAILED: [${invalidFields}]`);
        }
        throw error;
    }

    // Kiểm tra tính chặt chẽ của APP_ORIGIN (phải là exact origin, không có path con hay trailing slash)
    const origin = new URL(parsed.APP_ORIGIN);
    if (!['http:', 'https:'].includes(origin.protocol) || origin.origin !== parsed.APP_ORIGIN) {
        throw new Error('APP_ORIGIN_MUST_BE_EXACT_ORIGIN: APP_ORIGIN phải là origin chuẩn (ví dụ http://127.0.0.1:5173), không có path con hay dấu gạch chéo cuối');
    }

    // Kiểm tra giao thức database phải là postgres
    const db = new URL(parsed.DATABASE_URL);
    if (!['postgres:', 'postgresql:'].includes(db.protocol)) {
        throw new Error('DATABASE_URL_MUST_BE_POSTGRES: URL cơ sở dữ liệu phải bắt đầu bằng postgres:// hoặc postgresql://');
    }

    // Chặn secret ví dụ hoặc secret lặp ký tự (kém ngẫu nhiên)
    if (parsed.SESSION_SECRET.toLowerCase() === PUBLISHED_EXAMPLE_SECRET || /^([a-f0-9])\1+$/i.test(parsed.SESSION_SECRET)) {
        throw new Error('SESSION_SECRET_INSECURE: Không được dùng secret mẫu hoặc secret lặp ký tự');
    }

    // Môi trường production bắt buộc dùng HTTPS cho APP_ORIGIN
    if (parsed.NODE_ENV === 'production' && origin.protocol !== 'https:') {
        throw new Error('PRODUCTION_REQUIRES_HTTPS: Môi trường production bắt buộc APP_ORIGIN dùng giao thức https://');
    }

    if (parsed.CAMERA_MEDIA_MODE === 'ros') {
        const media = parsed.CAMERA_WHEP_BASE_URL && new URL(parsed.CAMERA_WHEP_BASE_URL);
        if (!media || media.protocol !== 'https:' || media.origin !== parsed.CAMERA_WHEP_BASE_URL) {
            throw new Error('CAMERA_WHEP_BASE_URL_MUST_BE_HTTPS_ORIGIN');
        }
    }

    return Object.freeze(parsed);
}
