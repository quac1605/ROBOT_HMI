import test from 'node:test';
import assert from 'node:assert/strict';
import { createLogger } from '../src/logger.js';

test('logger không ghi canary cookie, CSRF, owner token, password hoặc DB URL', () => {
  let output = '';
  const logger = createLogger({
    destination: { write: text => { output += text; } },
  });
  logger.info({
    req: { headers: {
      cookie: 'cookie-canary-123',
      'x-csrf-token': 'csrf-canary-123',
      'x-hmi-owner-token': 'owner-canary-123',
    } },
    password: 'password-canary-123',
    DATABASE_URL: 'db-canary-123',
    freshnessToken: 'freshness-canary-123',
  }, 'redaction test');
  for (const marker of ['cookie-canary', 'csrf-canary', 'owner-canary',
    'password-canary', 'db-canary', 'freshness-canary']) {
    assert.equal(output.includes(marker), false, marker);
  }
  assert.match(output, /REDACTED/);
});
