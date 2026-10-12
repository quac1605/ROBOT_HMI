import { readFile } from 'node:fs/promises';

// Explicit order prevents a new file from being applied accidentally at startup.
export const MIGRATION_NAMES = Object.freeze([
  '001_initial_schema.sql',
  '002_persistence_recovery.sql',
]);

export async function loadMigrations() {
  return Promise.all(MIGRATION_NAMES.map(async name => ({
    name,
    sql: await readFile(new URL(`../../migrations/${name}`, import.meta.url), 'utf8'),
  })));
}
