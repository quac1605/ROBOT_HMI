/**
 * backend/src/logger.js
 * 
 * BỘ GHI LOG CẤU TRÚC VỚI CƠ CHẾ REDACTION TỰ ĐỘNG (M3).
 */
import pino from 'pino';

/**
 * Danh sách đường dẫn các trường nhạy cảm cần redact (thay thế bằng '[REDACTED]')
 */
const REDACT_PATHS = [
  'req.headers.cookie',
  'req.headers.authorization',
  'req.headers["x-csrf-token"]',
  'req.headers["x-hmi-owner-token"]',
  'res.headers["set-cookie"]',
  'password',
  'passwordHash',
  'sessionSecret',
  'SESSION_SECRET',
  'DATABASE_URL',
  'databaseUrl',
  'freshnessToken',
  'ownerToken',
];

export function createLogger({ nodeEnv = 'development', level = 'info', destination } = {}) {
  const isTest = nodeEnv === 'test';
  return pino({
    level: isTest ? 'silent' : level, // Trong môi trường unit test, im lặng để output test sạch sẽ
    redact: {
      paths: REDACT_PATHS,
      censor: '[REDACTED]',
    },
    timestamp: pino.stdTimeFunctions.isoTime,
    formatters: {
      level(label) {
        return { level: label };
      },
    },
  }, destination);
}
