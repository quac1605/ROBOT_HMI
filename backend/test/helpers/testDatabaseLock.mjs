import pg from 'pg';
import { assertTestTarget } from '../../scripts/assert-test-target.mjs';

// Các integration test dùng cùng database nhưng tạo map assets trong DATA_DIR
// riêng. listMaps() đọc mọi ready map, nên phải giữ trọn vòng đời fixture
// (tạo -> HTTP/WS assertions -> xóa) dưới cùng một khóa liên process.
// Khóa session tự được PostgreSQL nhả nếu tiến trình test chết.
const MAP_FIXTURE_LOCK_KEY = 9127002;

export async function acquireMapFixtureLock(env = process.env) {
    // Kiểm tra cả role/database và thư mục trước khi mở session khóa.
    await assertTestTarget(env);
    const client = new pg.Client({ connectionString: env.DATABASE_URL });
    await client.connect();
    try {
        // Tránh treo vô hạn nếu một test khác giữ khóa và không kết thúc.
        await client.query("SET statement_timeout = '30000ms'");
        await client.query('SELECT pg_advisory_lock($1::bigint)', [MAP_FIXTURE_LOCK_KEY]);
    } catch (error) {
        await client.end();
        throw error;
    }

    let released = false;
    return async function releaseMapFixtureLock() {
        if (released) return;
        released = true;
        try {
            await client.query('SELECT pg_advisory_unlock($1::bigint)', [MAP_FIXTURE_LOCK_KEY]);
        } finally {
            await client.end();
        }
    };
}
