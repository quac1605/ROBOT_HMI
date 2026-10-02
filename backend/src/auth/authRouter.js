import { Router } from 'express';
import rateLimit from 'express-rate-limit';
import { z } from 'zod';

const LoginSchema = z.object({
  username: z.string().trim().min(3).max(64),
  password: z.string().min(1).max(1024),
}).strict();

function requireExactOrigin(expected) {
  return (req, _res, next) => {
    if (req.get('origin') !== expected) {
      return next(Object.assign(new Error('ORIGIN_FORBIDDEN'),
        { code: 'ORIGIN_FORBIDDEN', status: 403 }));
    }
    next();
  };
}

function saveSession(req) {
  return new Promise((resolve, reject) =>
    req.session.save(error => error ? reject(error) : resolve()));
}

export function createAuthRouter({ config, passport, lifecycle }) {
  const router = Router();
  const origin = requireExactOrigin(config.APP_ORIGIN);
  const loginLimiter = rateLimit({
    windowMs: 60_000,
    max: 10,
    standardHeaders: true,
    legacyHeaders: false,
    handler: (req, res) => res.status(429).json({
      error: { code: 'RATE_LIMITED', message: 'Thử lại sau ít phút.' },
      requestId: req.id,
    }),
  });

  router.get('/csrf', async (req, res, next) => {
    try {
      let csrfToken;
      try {
        csrfToken = lifecycle.issueCsrf(req);
      } catch (error) {
        if (!['SESSION_EXPIRED', 'SESSION_REVOKED'].includes(error.code)) throw error;
        // Sau restart/absolute expiry, HttpOnly cookie cũ vẫn được gửi.
        // Fence phiên cũ trước await rồi tạo phiên anonymous mới để đăng nhập lại.
        lifecycle.invalidate(req.sessionID, 'SESSION_EXPIRED');
        await new Promise((resolve, reject) =>
          req.session.regenerate(regenerateError => regenerateError ? reject(regenerateError) : resolve()));
        req.user = null;
        csrfToken = lifecycle.issueCsrf(req);
      }
      await saveSession(req); // Browser chỉ nhận token sau khi DB giữ session đó.
      res.json({ csrfToken });
    } catch (error) { next(error); }
  });

  router.post('/login', origin, loginLimiter, lifecycle.requireCsrf, (req, res, next) => {
    const parsed = LoginSchema.safeParse(req.body);
    if (!parsed.success || Buffer.byteLength(parsed.data.password, 'utf8') > 1024) {
      return next(Object.assign(new Error('INVALID_CREDENTIALS_PAYLOAD'),
        { code: 'INVALID_CREDENTIALS_PAYLOAD', status: 400 }));
    }
    const oldSid = req.sessionID;
    passport.authenticate('local', async (error, user) => {
      if (error) return next(error);
      if (!user) {
        return res.status(401).json({
          error: { code: 'INVALID_CREDENTIALS', message: 'Tài khoản hoặc mật khẩu không chính xác.' },
          requestId: req.id,
        });
      }
      try {
        // Credential lookup là async: logout hoặc login khác có thể đã thắng.
        lifecycle.assertLoginAttemptCurrent(req, oldSid);
        lifecycle.invalidate(oldSid, 'SESSION_ROTATED');
        // Passport 0.7 regenerate và save trong req.logIn; không regenerate lần nữa.
        await new Promise((resolve, reject) =>
          req.logIn(user, loginError => loginError ? reject(loginError) : resolve()));
        lifecycle.initializeAuthenticatedSession(req);
        const csrf = lifecycle.issueCsrf(req);
        await saveSession(req);
        res.setHeader('X-CSRF-Token', csrf);
        res.json({ user: { id: user.id, username: user.username } });
      } catch (loginError) { next(loginError); }
    })(req, res, next);
  });

  router.get('/session', lifecycle.requireAuth, (req, res) => {
    res.json({ user: { id: req.user.id, username: req.user.username } });
  });

  router.post('/logout', origin, lifecycle.requireAuth, lifecycle.requireCsrf,
    (req, res, next) => {
      try {
        const sid = req.sessionID;
        lifecycle.invalidate(sid, 'LOGOUT'); // Fence trước DB I/O.
        req.logOut(error => {
          if (error) return next(error);
          req.session.destroy(destroyError => {
            if (destroyError) return next(destroyError);
            res.clearCookie('connect.sid', { path: '/' });
            res.status(204).end();
          });
        });
      } catch (error) { next(error); }
    });

  return router;
}
