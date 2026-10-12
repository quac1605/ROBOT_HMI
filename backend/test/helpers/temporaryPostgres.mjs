import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { promisify } from 'node:util';
import { execFile } from 'node:child_process';
import pg from 'pg';

const run = promisify(execFile);

// Only used after assertTestTarget() has confirmed the local guarded test DB.
// The temporary cluster has no TCP listener and a private Unix socket.
export async function startTemporaryPostgres(root) {
  const { stdout } = await run('pg_config', ['--bindir']);
  const bin = stdout.trim();
  const dataDir = path.join(root, 'pgdata');
  // Unix-domain socket paths are limited to roughly 108 bytes on Linux.
  const socketDir = await fs.mkdtemp(path.join(os.tmpdir(), 'rhmi-pg-'));
  await fs.mkdir(root, { recursive: true, mode: 0o700 });
  await fs.chmod(socketDir, 0o700);
  const pgCtl = path.join(bin, 'pg_ctl');
  let started = false;
  let admin;
  try {
    await run(path.join(bin, 'initdb'),
      ['-D', dataDir, '-A', 'trust', '--no-instructions'],
      { timeout: 30_000, env: { ...process.env, LC_ALL: 'C' } });
    const escapedSocketDir = socketDir.replaceAll("'", "''");
    await fs.appendFile(path.join(dataDir, 'postgresql.conf'),
      `\nlisten_addresses = ''\nunix_socket_directories = '${escapedSocketDir}'\nport = 55432\n`);
    await run(pgCtl, ['-D', dataDir, '-l', path.join(root, 'postgres.log'), '-w', 'start'],
      { timeout: 30_000 });
    started = true;
    const connection = { host: socketDir, port: 55432,
      user: os.userInfo().username };
    admin = new pg.Pool({ ...connection, database: 'postgres', max: 1 });
    await admin.query('CREATE DATABASE robot_hmi_restore_test');
    await admin.end();
    admin = null;
    const pool = new pg.Pool({ ...connection,
      database: 'robot_hmi_restore_test', max: 4 });
    return {
      pool,
      async stop() {
        await pool.end();
        await run(pgCtl, ['-D', dataDir, '-m', 'immediate', '-w', 'stop'],
          { timeout: 30_000 });
        started = false;
        await fs.rm(socketDir, { recursive: true, force: true });
      },
    };
  } catch (error) {
    if (admin) await admin.end().catch(() => {});
    if (started) await run(pgCtl, ['-D', dataDir, '-m', 'immediate', '-w', 'stop'],
      { timeout: 30_000 }).catch(() => {});
    await fs.rm(socketDir, { recursive: true, force: true });
    throw error;
  }
}
