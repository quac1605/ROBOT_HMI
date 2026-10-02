/**
 * backend/test/config.test.mjs
 * 
 * Kiểm thử tính năng fail-fast và các ràng buộc an toàn của config (M3).
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { loadConfig } from '../src/config.js';

// Secret 64 hex hợp lệ ngẫu nhiên cho môi trường test
const VALID_TEST_SECRET = '1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef';

function makeBaseEnv() {
    return {
        NODE_ENV: 'test',
        HOST: '127.0.0.1',
        PORT: '3001',
        APP_ORIGIN: 'http://127.0.0.1:5173',
        DATABASE_URL: 'postgres://test:test@127.0.0.1:5432/robot_hmi_test',
        SESSION_SECRET: VALID_TEST_SECRET,
        ROBOT_ADAPTER: 'mock',
        DATA_DIR: '/tmp/robot_hmi_test_data',
        TRUST_LOOPBACK_PROXY: 'false',
    };
}

test('loadConfig nạp thành công với cấu hình hợp lệ và trả về frozen object', () => {
    const cfg = loadConfig(makeBaseEnv());
    assert.equal(cfg.PORT, 3001);
    assert.equal(cfg.ROBOT_ADAPTER, 'mock');
    assert.ok(Object.isFrozen(cfg), 'Config object phải được freeze');
});

test('loadConfig ném lỗi khi thiếu trường bắt buộc', () => {
    const env = makeBaseEnv();
    delete env.DATABASE_URL;
    assert.throws(() => loadConfig(env), /CONFIG_VALIDATION_FAILED.*DATABASE_URL/);
});

test('loadConfig từ chối APP_ORIGIN có path con hoặc dấu gạch chéo cuối', () => {
    const env = makeBaseEnv();
    env.APP_ORIGIN = 'http://127.0.0.1:5173/subpath';
    assert.throws(() => loadConfig(env), /APP_ORIGIN_MUST_BE_EXACT_ORIGIN/);
});

test('loadConfig từ chối DATABASE_URL không phải PostgreSQL', () => {
    const env = makeBaseEnv();
    env.DATABASE_URL = 'mysql://user:pass@127.0.0.1:3306/db';
    assert.throws(() => loadConfig(env), /DATABASE_URL_MUST_BE_POSTGRES/);
});

test('loadConfig từ chối SESSION_SECRET mẫu hoặc kém ngẫu nhiên', () => {
    const env1 = makeBaseEnv();
    env1.SESSION_SECRET = 'c5f78b824a733e88a38914fc2ee9d44399856992ee6c052ef7bb78540a735f6a';
    assert.throws(() => loadConfig(env1), /SESSION_SECRET_INSECURE/);

    const env2 = makeBaseEnv();
    env2.SESSION_SECRET = 'a'.repeat(64); // Ký tự lặp
    assert.throws(() => loadConfig(env2), /SESSION_SECRET_INSECURE/);
});

test('loadConfig từ chối ROBOT_ADAPTER khác mock', () => {
    const env = makeBaseEnv();
    env.ROBOT_ADAPTER = 'ros'; // Không cho phép fallback hay chỉ định ros ở Chặng 9
    assert.throws(() => loadConfig(env), /CONFIG_VALIDATION_FAILED.*ROBOT_ADAPTER/);
});

test('loadConfig bắt buộc HTTPS cho APP_ORIGIN trong môi trường production', () => {
    const env = makeBaseEnv();
    env.NODE_ENV = 'production';
    env.APP_ORIGIN = 'http://127.0.0.1:5173';
    assert.throws(() => loadConfig(env), /PRODUCTION_REQUIRES_HTTPS/);
});
