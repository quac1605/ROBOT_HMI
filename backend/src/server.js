/** Composition root: importing this module does not open a port. */
import { createServer } from 'node:http';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import pg from 'pg';
import { loadConfig } from './config.js';
import { createLogger } from './logger.js';
import { createApp } from './app.js';
import { createSessionLifecycle } from './auth/sessionLifecycle.js';
import { createSessionRevalidator } from './auth/sessionRevalidator.js';
import { createUsersRepository } from './auth/usersRepository.js';
import { createPassportInstance } from './auth/passport.js';
import { attachAuthWebSockets } from './auth/authWebSockets.js';
import { createConnectionRegistry } from './realtime/connectionRegistry.js';
import { createAssetStore } from './storage/assetStore.js';
import { createMapPersistence } from './db/mapPersistence.js';
import { reconcileInterruptedMissions } from './db/runtimeRecovery.js';
import { createRobotRuntime } from './runtime.js';

export function createServerRuntime(env = process.env) {
  const config = loadConfig(env);
  const logger = createLogger({ nodeEnv: config.NODE_ENV });
  let started = null;
  let starting = null;

  async function start({ port = config.PORT, host = config.HOST } = {}) {
    if (started) return started;
    if (starting) return starting;
    starting = (async () => {
      // A single pool, auth lifecycle and robot authority serve HTTP and WS.
      // The operator/test runner applies migrations separately.
      const pool = new pg.Pool({ connectionString: config.DATABASE_URL });
      const lifecycle = createSessionLifecycle();
      const registry = createConnectionRegistry();
      const readinessState = {
        isReady: () => false, // Complete M8/M9 readiness needs verified sources.
        isAuthAvailable: () => !lifecycle.isLockedDown,
        getDetails: () => 'Robot source and workflows are not verified',
      };
      let robotRuntime;
      let app;
      let server;
      let authWebSockets;
      let unsubscribeRevoke;
      let sessionStore;
      let stopping = null;

      const onPoolError = () => {
        lifecycle.invalidateAll('DATABASE_UNAVAILABLE');
        // Stop command authority before any future DB recovery.
        try { robotRuntime?.adapter.ensureStopped(); } catch { /* already stopped */ }
        try {
          robotRuntime?.sharedRobotState.update({
            motionInhibited: true, motionInhibitReason: 'DATABASE_UNAVAILABLE',
          });
        } catch { /* shutdown may already have disposed the runtime */ }
      };
      pool.on('error', onPoolError);

      async function closeResources() {
        if (stopping) return stopping;
        stopping = (async () => {
          unsubscribeRevoke?.();
          // Fence autonomous progress and zero intent before asynchronous IO.
          robotRuntime?.missionService?.dispose();
          robotRuntime?.adapter.ensureStopped();
          await authWebSockets?.close();
          registry.closeAll();
          robotRuntime?.dispose();
          if (server?.listening) {
            await new Promise((resolve, reject) => {
              server.close(error => error ? reject(error) : resolve());
              server.closeAllConnections();
            });
          }
          await sessionStore?.close();
          pool.off('error', onPoolError);
          await pool.end();
        })();
        return stopping;
      }

      try {
        await pool.query('SELECT 1');
        const assetStore = createAssetStore({ dataDir: config.DATA_DIR });
        await assetStore.init();
        const mapPersistence = createMapPersistence({ pool, assetStore });
        await mapPersistence.reconcile({ robotId: 'robot-01' });
        await reconcileInterruptedMissions(pool, { robotId: 'robot-01' });

        const users = await createUsersRepository(pool);
        const passport = createPassportInstance({ users, dummyHash: users.dummyHash });
        robotRuntime = createRobotRuntime({
          pool, config, logger, lifecycle, connectionRegistry: registry,
          mapPersistence, assetStore,
        });
        app = createApp({
          config, logger, readinessState, pool, passport, lifecycle,
          robotRuntime, connectionRegistry: registry,
        });
        sessionStore = app.locals.sessionStore;
        const sessionRevalidator = createSessionRevalidator({
          sessionStore, users, lifecycle,
        });

        unsubscribeRevoke = lifecycle.onRevoke((sid, reason) => {
          if (sid === null) {
            registry.closeAll();
            robotRuntime.controlSubjectRegistry.dispose();
            return;
          }
          registry.terminateSession(sid, reason);
          robotRuntime.controlSubjectRegistry.removeSessionSubject(sid);
        });

        server = createServer(app);
        authWebSockets = attachAuthWebSockets({
          server, config, lifecycle, sessionRevalidator, registry,
          controlAuthority: robotRuntime.controlAuthority,
          controlSubjectRegistry: robotRuntime.controlSubjectRegistry,
          mapGridService: robotRuntime.mapGridService,
          robotStateService: robotRuntime.robotStateService,
        });
        await new Promise((resolve, reject) => {
          const failed = error => { server.off('listening', resolve); reject(error); };
          server.once('error', failed);
          server.once('listening', () => {
            server.off('error', failed);
            resolve();
          });
          server.listen(port, host);
        });

        started = {
          app, server, pool, lifecycle, registry, authWebSockets,
          sessionRevalidator, mapPersistence, assetStore, robotRuntime,
          sharedRobotState: robotRuntime.sharedRobotState,
          motionSource: robotRuntime.adapter,
          controlAuthority: robotRuntime.controlAuthority,
          controlSubjectRegistry: robotRuntime.controlSubjectRegistry,
          motionGate: robotRuntime.motionGate,
          readinessState, stop: closeResources,
        };
        return started;
      } catch (error) {
        await closeResources().catch(() => {});
        throw error;
      }
    })();
    try { return await starting; }
    finally { starting = null; }
  }

  async function stop() {
    if (starting) await starting.catch(() => {});
    if (!started) return;
    const current = started;
    started = null;
    await current.stop();
  }

  return {
    start, stop,
    get app() { return started?.app; },
    get registry() { return started?.registry; },
    get controlAuthority() { return started?.controlAuthority; },
    get controlSubjectRegistry() { return started?.controlSubjectRegistry; },
    get motionGate() { return started?.motionGate; },
    get motionSource() { return started?.motionSource; },
  };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const runtime = createServerRuntime();
  runtime.start().then(({ server }) => {
    const address = server.address();
    console.log(`ROBOT_HMI backend listening on ${address.address}:${address.port}`);
  }).catch(() => {
    console.error('BACKEND_START_FAILED');
    process.exitCode = 1;
  });
  const shutdown = () => runtime.stop().then(() => {
    process.exitCode = 0;
  }).catch(() => {
    process.exitCode = 1;
  });
  process.once('SIGINT', shutdown);
  process.once('SIGTERM', shutdown);
}
