/**
 * backend/src/auth/usersRepository.js
 * 
 * QUẢN LÝ DỮ LIỆU TÀI KHOẢN VÀ SEED ADMIN BAN ĐẦU (M5).
 */
import argon2 from 'argon2';

export async function createUsersRepository(pool) {
    // Tạo sẵn dummy hash một lần lúc khởi động để dùng khi username không tồn tại
    const dummyHash = await argon2.hash('dummy-password-for-timing-defense');

    async function findByUsername(username) {
        const { rows } = await pool.query(
            'SELECT id, username, password_hash AS "passwordHash", enabled FROM users WHERE username = $1',
            [username]
        );
        return rows[0] || null;
    }

    async function findEnabledById(id) {
        const { rows } = await pool.query(
            'SELECT id, username FROM users WHERE id = $1 AND enabled = true',
            [id]
        );
        return rows[0] || null;
    }

    async function ensureAdminUser({ username = 'admin', password }) {
        if (typeof username !== 'string' || !/^[A-Za-z0-9_-]{3,64}$/.test(username) ||
            typeof password !== 'string' || Buffer.byteLength(password, 'utf8') < 12 ||
            Buffer.byteLength(password, 'utf8') > 1024) {
            throw new Error('INVALID_ADMIN_PROVISION_INPUT');
        }
        const hash = await argon2.hash(password, { type: argon2.argon2id });
        const result = await pool.query(
            'INSERT INTO users (username, password_hash, enabled) VALUES ($1, $2, true) ' +
            'ON CONFLICT (username) DO NOTHING RETURNING id',
            [username, hash]
        );
        // Existing account is never silently re-enabled or given a new password.
        return { created: result.rowCount === 1 };
    }

    return { findByUsername, findEnabledById, ensureAdminUser, dummyHash };
}
