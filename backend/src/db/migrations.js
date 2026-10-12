/**
 * backend/src/db/migrations.js
 * 
 * TRÌNH CHẠY MIGRATION CƠ SỞ DỮ LIỆU GIAO DỊCH AN TOÀN (M4 / F4.1).
 */
import { createHash } from 'node:crypto';

/**
 * Áp dụng danh sách migration vào PostgreSQL.
 * @param {import('pg').Pool} pool 
 * @param {Array<{ name: string, sql: string }>} migrations 
 */
export async function migrate(pool, migrations) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    // Khóa Advisory Transaction Lock: hai runner đồng thời sẽ xếp hàng tuần tự
    await client.query('SELECT pg_advisory_xact_lock(9127001)');

    // Tạo bảng theo dõi lịch sử migration nếu chưa có
    await client.query(`CREATE TABLE IF NOT EXISTS schema_migrations (
      name TEXT PRIMARY KEY,
      sha256 TEXT NOT NULL,
      applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
    )`);

    for (const { name, sql } of migrations) {
      const hash = createHash('sha256').update(sql).digest('hex');
      const previous = await client.query('SELECT sha256 FROM schema_migrations WHERE name = $1', [name]);

      if (previous.rowCount > 0) {
        // Kiểm tra tính toàn vẹn: nếu migration đã chạy nhưng bị sửa đổi nội dung SQL -> báo lỗi drift
        if (previous.rows[0].sha256 !== hash) {
          throw new Error(`MIGRATION_DRIFT: Nội dung file migration ${name} đã bị thay đổi sau khi áp dụng!`);
        }
        continue; // Migration này đã được áp dụng an toàn trước đó
      }

      // Thực thi file migration mới
      await client.query(sql);
      await client.query('INSERT INTO schema_migrations (name, sha256) VALUES ($1, $2)', [name, hash]);
    }

    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    throw error;
  } finally {
    client.release();
  }
}
