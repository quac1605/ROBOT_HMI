/**
 * [READ FLOW STEP 7] Lắp các lớp HTTP theo thứ tự: bảo vệ response, parse body,
 * webhook nội bộ, session PostgreSQL, Passport, rồi API nghiệp vụ.
 * Thứ tự middleware là một phần của kiến trúc xác thực: webhook MediaMTX dùng
 * vé camera riêng, còn browser xin vé bằng session HMI đã đăng nhập.
 * @module backend/app
 */
import { createNavigationRouter } from './routes/navigationRouter.js';
import { createCameraRouter } from './routes/cameraRouter.js';
import express from 'express';
import helmet from 'helmet';
import { randomUUID } from 'node:crypto';
import session from 'express-session';
import connectPgSimple from 'connect-pg-simple';
import { createAuthRouter } from './auth/authRouter.js';
import { createControlRouter } from './control/controlRouter.js';
import { createMapsRouter } from './routes/mapsRouter.js';
import { createRosMapRouter } from './routes/rosMapRouter.js';
import { createMappingRouter } from './routes/mappingRouter.js';

/**
 * Tạo Express app; server.js chịu trách nhiệm mở cổng và quản lý vòng đời runtime.
 * @param {object} dependencies Các phụ thuộc do server/runtime tạo trước.
 * @param {object} dependencies.config Cấu hình origin, session, mode media.
 * @param {object} dependencies.logger Logger đã cấu hình lọc thông tin nhạy cảm.
 * @param {object} dependencies.readinessState Trạng thái sẵn sàng của phụ thuộc.
 * @param {object} dependencies.pool PostgreSQL pool dùng cho session store.
 * @param {object} dependencies.passport Passport với strategy đã đăng ký.
 * @param {object} dependencies.lifecycle Kiểm tra, thu hồi session và CSRF.
 * @param {object} dependencies.robotRuntime Các service robot/map/camera hiện hành.
 * @param {object} [dependencies.controlAuthority] Override authority của runtime.
 * @param {object} [dependencies.controlSubjectRegistry] Bảng chủ thể điều khiển.
 * @param {object} [dependencies.connectionRegistry] Registry WebSocket để bind tab.
 * @param {boolean} [dependencies.healthOnly=false] Chỉ expose health khi cần.
 * @returns {import('express').Express} App chưa listen, có thể inject vào test HTTP.
 * @throws {Error} AUTH_DEPENDENCIES_REQUIRED nếu thiếu pool/Passport/lifecycle.
 */
export function createApp({
    config,
    logger,
    readinessState,
    pool,
    passport,
    lifecycle,
    robotRuntime,
    controlAuthority,
    controlSubjectRegistry,
    connectionRegistry,
    healthOnly = false,
}) {
    const app = express();
    if (!healthOnly && (!pool || !passport || !lifecycle)) {
        throw new Error('AUTH_DEPENDENCIES_REQUIRED');
    }

    if (config.TRUST_LOOPBACK_PROXY === 'true') {
        app.set('trust proxy', 'loopback');
    }

    app.use(helmet({
        contentSecurityPolicy: config.NODE_ENV === 'production',
        crossOriginEmbedderPolicy: false,
    }));

    app.use((req, res, next) => {
        req.id = randomUUID();
        res.setHeader('X-Request-Id', req.id);
        next();
    });

    app.use('/api', (_req, res, next) => {
        // Descriptor chứa bearer grant: không để cache dùng lại response cho người
        // khác hoặc trả vé cũ đã hết hạn. Header này áp dụng cho toàn bộ API.
        res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, private');
        res.setHeader('Pragma', 'no-cache');
        next();
    });

    app.use('/api', express.json({ limit: '64kb' }));

    if (!healthOnly && config.CAMERA_MEDIA_MODE === 'ros') {
        /**
         * [READ FLOW STEP 7] Webhook xác thực WHEP do MediaMTX gọi bằng HTTP local.
         * Handler nằm trước express-session vì MediaMTX không có cookie browser.
         * @param {import('express').Request} req JSON auth action/path/protocol/token.
         * @param {import('express').Response} res 204 cho phép; 401 sai vé; 403 sai peer.
         * @returns {void} Không trả token và không stream video trong response.
         */
        app.post('/api/internal/camera-media-auth', (req, res) => {
            // Dùng peer TCP thật, không tin X-Forwarded-For do bên gọi tự đặt.
            // Loopback là lớp giới hạn caller; token + SID + path vẫn phải hợp lệ.
            // Proxy local có thể cũng xuất hiện là loopback, nên không xem phép
            // kiểm tra địa chỉ này là bằng chứng duy nhất của danh tính MediaMTX.
            const remote = req.socket.remoteAddress;
            if (remote !== '127.0.0.1' && remote !== '::1' &&
                remote !== '::ffff:127.0.0.1') {
                res.sendStatus(403);
                return;
            }
            res.sendStatus(robotRuntime.cameraService.authorizeMediaRequest(req.body) ? 204 : 401);
        });
    }

    // Health check routes
    app.get('/api/health/live', (_req, res) => {
        res.status(200).json({ status: 'ok', live: true });
    });

    app.get('/api/health/ready', (_req, res) => {
        const isReady = readinessState ? readinessState.isReady() : false;
        if (isReady) {
            res.status(200).json({ status: 'ok', ready: true });
        } else {
            res.status(503).json({
                status: 'unready',
                ready: false,
                details: readinessState?.getDetails?.() ?? 'System initializing or degraded',
            });
        }
    });

    if (!healthOnly) {
        app.use('/api/auth', (_req, _res, next) => {
            if (readinessState?.isAuthAvailable?.() === false) {
                return next(Object.assign(new Error('AUTH_UNAVAILABLE'),
                    { code: 'AUTH_UNAVAILABLE', status: 503 }));
            }
            next();
        });
        const PgStore = connectPgSimple(session);
        const sessionStore = new PgStore({
            pool,
            tableName: 'session',
            createTableIfMissing: false,
        });
        app.locals.sessionStore = sessionStore;

        app.use(session({
            store: sessionStore,
            secret: config.SESSION_SECRET,
            resave: false,
            saveUninitialized: false,
            name: 'connect.sid',
            cookie: {
                httpOnly: true,
                // LAN preview terminates HTTPS at the loopback Vite proxy.
                // Only trust its forwarded scheme when loopback proxy trust
                // was explicitly enabled; local HTTP tests retain old behavior.
                secure: config.NODE_ENV === 'production' ||
                    (config.TRUST_LOOPBACK_PROXY === 'true' &&
                        new URL(config.APP_ORIGIN).protocol === 'https:'),
                sameSite: 'lax',
                maxAge: 8 * 60 * 60 * 1000,
                path: '/',
            },
        }));

        app.use((req, _res, next) => {
            req.hadStoredPassportUser = Boolean(req.session?.passport?.user);
            next();
        });
        app.use(passport.initialize());
        app.use(passport.session());
        app.use((req, _res, next) => {
            if (req.hadStoredPassportUser && !req.isAuthenticated()) {
                try {
                    lifecycle.invalidate(req.sessionID, 'USER_DISABLED_OR_MISSING');
                } catch (error) { return next(error); }
            }
            next();
        });

        // 1. Auth Router (/api/auth)
        const authRouter = createAuthRouter({ config, passport, lifecycle });
        app.use('/api/auth', authRouter);

        // 2. Control Router (/api/control)
        const authority = controlAuthority || robotRuntime?.controlAuthority;
        const subjects = controlSubjectRegistry || robotRuntime?.controlSubjectRegistry;
        if (authority && subjects && connectionRegistry) {
            const controlRouter = createControlRouter({
                lifecycle,
                registry: connectionRegistry,
                authority,
                subjects,
            });
            app.use('/api/control', controlRouter);
        }

        // 3. Robot State Route (/api/robot/state) - M8 Slice 1
        app.get('/api/robot/state', lifecycle.requireAuth, (_req, res, next) => {
            try {
                if (!robotRuntime?.robotStateService) {
                    return res.status(503).json({
                        error: { code: 'ROBOT_RUNTIME_UNAVAILABLE', message: 'Robot runtime chưa sẵn sàng' },
                    });
                }
                const state = robotRuntime.robotStateService.getRobotState();
                res.status(200).json(state);
            } catch (err) {
                next(err);
            }
        });

        // 4. Maps & Occupancy Grid Router (/api/maps, /api/map-grid) - M8 Slice 2
        if (robotRuntime?.mapGridService) {
            const mapsRouter = createMapsRouter({
                lifecycle,
                mapGridService: robotRuntime.mapGridService,
            });
            app.use('/api', mapsRouter);
        }
        if (robotRuntime?.rosMapService) {
            app.use('/api', createRosMapRouter({
                lifecycle, rosMapService: robotRuntime.rosMapService,
            }));
        }

        // 5. Mapping Workflow, Jobs & Activation Router - M8 Slice 3
        if (robotRuntime?.mappingService && robotRuntime?.jobService && robotRuntime?.mapActivationService) {
            const mappingRouter = createMappingRouter({
                lifecycle,
                mappingService: robotRuntime.mappingService,
                jobService: robotRuntime.jobService,
                mapActivationService: robotRuntime.mapActivationService,
            });
            app.use('/api', mappingRouter);
        }
                // 6. Navigation Router (Routes & Missions) - M8 Slice 4
        if (robotRuntime?.routeService && robotRuntime?.missionService) {
            const navigationRouter = createNavigationRouter({
                lifecycle,
                routeService: robotRuntime.routeService,
                missionService: robotRuntime.missionService,
                cmdInService: robotRuntime.cmdInService,
            });
            app.use('/api', navigationRouter);
        }

        // [READ FLOW STEP 10] Browser vào router này sau session + Passport;
        // nó nhận descriptor để gọi WHEP, không nhận ảnh raw từ Express.
        if (robotRuntime?.cameraService) {
            const cameraRouter = createCameraRouter({
                lifecycle,
                cameraService: robotRuntime.cameraService,
            });
            app.use('/api', cameraRouter);
        }

    }

    // Catch-all 404
    app.use('/api', (req, res) => {
        res.status(404).json({
            error: {
                code: 'NOT_FOUND',
                message: 'Endpoint không tồn tại.',
            },
            requestId: req.id,
        });
    });

    // Centralized error handler
    app.use('/api', (err, req, res, _next) => {
        let status = Number.isInteger(err.status) && err.status >= 400 && err.status <= 599
            ? err.status : 500;
        if (status >= 500 && req.originalUrl.startsWith('/api/auth/')) {
            readinessState?.setAuthAvailable?.(false);
            lifecycle?.invalidateAll('AUTH_DEPENDENCY_UNAVAILABLE');
            status = 503;
        }
        const publicCodes = new Set([
            'AUTH_UNAVAILABLE', 'UNAUTHORIZED', 'SESSION_REVOKED', 'SESSION_EXPIRED',
            'CSRF_EXPIRED', 'CSRF_REJECTED', 'ORIGIN_FORBIDDEN',
            'INVALID_CREDENTIALS_PAYLOAD', 'RATE_LIMITED',
            'OWNER_BINDING_REJECTED', 'FORBIDDEN',
            'CONTROL_BUSY', 'LEASE_BUSY', 'LEASE_NOT_OWNED',
            'CONTROL_MUTATION_IN_PROGRESS', 'STOP_IN_PROGRESS', 'STOP_UNCONFIRMED',
            'ROBOT_NOT_STATIONARY', 'MODE_NOT_ALLOWED', 'ESTOP_ACTIVE_OR_UNKNOWN',
            'MOTION_INHIBITED_OR_UNKNOWN', 'MISSION_ACTIVE_OR_UNKNOWN',
            'MAPPING_ACTIVE_OR_UNKNOWN', 'ROS_UNAVAILABLE', 'TRANSPORT_UNHEALTHY',
            'CONTROL_RESOURCE_EXHAUSTED', 'VALIDATION_ERROR', 'NOT_FOUND',
            'ADAPTER_CAPABILITY_MISSING', 'ROBOT_RUNTIME_UNAVAILABLE',
            'MAP_NOT_FOUND', 'JOB_NOT_FOUND', 'MISSION_NOT_FOUND', 'ROUTE_NOT_FOUND',
            'CAMERA_NOT_FOUND', 'MAPPING_SESSION_NOT_FINISHABLE', 'MOTION_ADMISSION_BLOCKED',
            'MAP_CONTEXT_MISMATCH', 'MAP_TOO_LARGE', 'INVALID_MAP_DATA',
            'POSE_OUTSIDE_MAP',
            'ACTIVATION_CONTEXT_MISMATCH', 'ACTIVATION_UNCERTAIN',
            'PATH_TOO_LARGE', 'MAP_ASSET_UNAVAILABLE', 'MAP_ASSETS_INCOMPLETE',
            'MAPPING_GRID_UNAVAILABLE',
            'READY_MAP_IMMUTABLE', 'IDEMPOTENCY_CONFLICT',
            'ORIGINAL_POSITION_REQUIRED', 'ORIGINAL_POSITION_ALREADY_SET',
        ]);
        const code = status === 503 && req.originalUrl.startsWith('/api/auth/') ? 'AUTH_UNAVAILABLE'
            : publicCodes.has(err.code) ? err.code
                : (status === 400 ? 'VALIDATION_ERROR' : 'INTERNAL_SERVER_ERROR');
        const message = code === 'INTERNAL_SERVER_ERROR'
            ? 'Đã xảy ra lỗi máy chủ nội bộ.' : code;

        if (logger && status >= 500) {
            logger.error({ requestId: req.id, code }, 'API Unhandled Error');
        }

        if (res.headersSent) return;
        res.status(status).json({
            error: { code, message },
            requestId: req.id,
        });
    });

    return app;
}
