/**
 * backend/test/migration.test.mjs
 * 
 * INTEGRATION TEST POSTGRESQL VÀ ASSET STORE CÓ TEST TARGET GUARD (M4).
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { assertTestTarget } from '../scripts/assert-test-target.mjs';
import { migrate } from '../src/db/migrations.js';
import { loadMigrations } from '../src/db/migrationFiles.js';
import { createAssetStore } from '../src/storage/assetStore.js';

const { Pool } = pg;

test('M4 Integration: migration checksum/rollback và asset store bất biến', async () => {
    // 1. CHỐT CHẶN BẮT BUỘC: Kiểm tra target DB test trước bất kỳ thao tác nào
    const guard = await assertTestTarget(process.env);
    assert.equal(guard.database, 'robot_hmi_test');
    assert.equal(guard.role, 'robot_hmi_test');

    const pool = new Pool({ connectionString: process.env.DATABASE_URL });
    const runDir = path.join(process.env.DATA_DIR, 'runs', randomUUID());

    try {
        // 2. Đọc file migration 001_initial_schema.sql
        const migrations = await loadMigrations();
        const sqlContent = migrations[0].sql;

        // 3. Chạy migration lần đầu
        await migrate(pool, migrations);
        await Promise.all([migrate(pool, migrations), migrate(pool, migrations)]);

        // Mỗi file đã áp dụng phải có checksum riêng; 002 không bị bỏ qua.
        for (const migration of migrations) {
            const checkRes = await pool.query(
                'SELECT sha256 FROM schema_migrations WHERE name=$1', [migration.name]);
            assert.equal(checkRes.rowCount, 1);
            assert.match(checkRes.rows[0].sha256, /^[a-f0-9]{64}$/);
        }

        // 4. Chạy lặp lại migration (Idempotent): Không được ném lỗi
        await migrate(pool, migrations);

        // 5. Kiểm tra tính năng phát hiện Migration Drift (Sửa nội dung SQL cũ phải bị chặn)
        const driftedMigrations = [{ name: '001_initial_schema.sql', sql: sqlContent + '\n-- Modified' }];
        await assert.rejects(
            () => migrate(pool, driftedMigrations),
            /MIGRATION_DRIFT/,
            'Migration bị sửa đổi nội dung phải ném lỗi MIGRATION_DRIFT'
        );

        // SQL lỗi phải rollback cả DDL lẫn ledger row của migration thử nghiệm.
        const unique = randomUUID().replaceAll('-', '');
        const failedName = `test_failure_${unique}.sql`;
        const tableName = `test_failure_${unique}`;
        await assert.rejects(() => migrate(pool, [
            ...migrations,
            { name: failedName, sql: `CREATE TABLE ${tableName}(id INTEGER); SELECT 1/0;` },
        ]));
        const rolledBack = await pool.query(
            'SELECT to_regclass($1) AS relation, (SELECT count(*) FROM schema_migrations WHERE name=$2) AS records',
            [`public.${tableName}`, failedName]
        );
        assert.equal(rolledBack.rows[0].relation, null);
        assert.equal(Number(rolledBack.rows[0].records), 0);

        // 6. Kiểm tra ràng buộc Partial Unique Index của mapping_sessions (chỉ 1 active session)
        const testRobotId = `robot-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
        const sessionId1 = `sess-1-${Date.now()}`;
        const sessionId2 = `sess-2-${Date.now()}`;
        try {
            await pool.query(
                'INSERT INTO mapping_sessions (id, robot_id, active, name, status) VALUES ($1, $2, true, $3, $4)',
                [sessionId1, testRobotId, 'Session 1', 'mapping']
            );
            await assert.rejects(
                () => pool.query(
                    'INSERT INTO mapping_sessions (id, robot_id, active, name, status) VALUES ($1, $2, true, $3, $4)',
                    [sessionId2, testRobotId, 'Session 2', 'mapping']
                ),
                /mapping_sessions_single_active_idx|unique constraint/i
            );
        } finally {
            await pool.query('DELETE FROM mapping_sessions WHERE robot_id = $1', [testRobotId]);
        }


        // 7. Kiểm tra Asset Store nguyên tử
        const assetStore = createAssetStore({ dataDir: runDir });
        const testMapData = JSON.stringify({ width: 10, height: 10, resolution: 0.05, data: [0, 100] });
        const assetResult = await assetStore.storeAsset({
            relativeKey: 'maps/map-01/rev-1/grid.json',
            data: testMapData,
        });

        assert.equal(assetResult.storageKey, 'maps/map-01/rev-1/grid.json');
        assert.match(assetResult.sha256, /^[a-f0-9]{64}$/);
        assert.equal(assetResult.byteCount, Buffer.byteLength(testMapData));

        // Đọc lại asset từ đĩa để xác nhận nội dung
        const readBuffer = await assetStore.readAsset('maps/map-01/rev-1/grid.json', assetResult);
        assert.equal(readBuffer.toString('utf8'), testMapData);

        await assert.rejects(() => assetStore.storeAsset({
            relativeKey: 'maps/map-01/rev-1/grid.json', data: 'replacement',
        }), /EEXIST/, 'Revision ready không được ghi đè');
        await assert.rejects(() => assetStore.readAsset('maps/map-01/rev-1/grid.json',
            { ...assetResult, sha256: '0'.repeat(64) }), /ASSET_HASH_MISMATCH/);
        await assert.rejects(() => assetStore.storeAsset({
            relativeKey: '../escape.json', data: 'x',
        }), /ASSET_INVALID_KEY/);
        const outside = path.join(runDir, 'outside');
        await fs.mkdir(outside);
        await fs.symlink(outside, path.join(runDir, 'assets', 'maps', 'link'));
        await assert.rejects(() => assetStore.storeAsset({
            relativeKey: 'maps/link/escape.json', data: 'x',
        }), /ASSET_UNSAFE_DIRECTORY/);

    } finally {
        await pool.end();
        // Chỉ xóa subtree do runId của test này tạo, không xóa DATA_DIR gốc.
        await fs.rm(runDir, { recursive: true, force: true });
    }
});
