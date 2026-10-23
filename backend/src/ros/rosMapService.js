import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';

const WORKER = fileURLToPath(new URL('./occupancy_map_worker.py', import.meta.url));
const PNG_SIGNATURE = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
const MAX_PNG_BYTES = 12 * 1024 * 1024;
const MAX_LINE_CHARS = Math.ceil(MAX_PNG_BYTES * 4 / 3) + 4096;
const MAX_CACHED_IMAGES = 8;
const MAX_CACHE_BYTES = 48 * 1024 * 1024;

function validStamp(value) {
    return Number.isInteger(value?.sec) && Number.isInteger(value?.nanosec) &&
        value.nanosec >= 0 && value.nanosec < 1_000_000_000;
}

function parseWorkerMap(value) {
    const geometry = value?.geometry;
    const counts = value?.counts;
    const cells = geometry?.width * geometry?.height;
    if (!/^[a-f0-9]{32}$/.test(value?.revision) ||
        typeof geometry?.frameId !== 'string' || !geometry.frameId ||
        !Number.isInteger(geometry?.width) || !Number.isInteger(geometry?.height) ||
        geometry.width < 1 || geometry.height < 1 || cells > 12_000_000 ||
        !Number.isFinite(geometry?.resolution) || geometry.resolution <= 0 ||
        !Number.isFinite(geometry?.origin?.x) || !Number.isFinite(geometry?.origin?.y) ||
        !Number.isFinite(geometry?.origin?.yaw) ||
        !validStamp(value.stamp) || !validStamp(value.mapLoadTime) ||
        !['unknown', 'free', 'occupied', 'other'].every(key =>
            Number.isInteger(counts?.[key]) && counts[key] >= 0) ||
        Object.values(counts).reduce((a, b) => a + b, 0) !== cells ||
        typeof value.pngBase64 !== 'string' || value.pngBase64.length > MAX_LINE_CHARS) {
        throw new Error('INVALID_ROS_MAP_WORKER_MESSAGE');
    }
    const image = Buffer.from(value.pngBase64, 'base64');
    if (!image.subarray(0, 8).equals(PNG_SIGNATURE) || image.length > MAX_PNG_BYTES) {
        throw new Error('INVALID_ROS_MAP_PNG');
    }
    return {
        metadata: {
            status: 'ready', topic: '/map', revision: value.revision,
            geometry, stamp: value.stamp, mapLoadTime: value.mapLoadTime, counts,
        },
        image,
    };
}

export function createRosMapService({
    enabled = false,
    setupPath = '/opt/ros/jazzy/setup.bash',
    logger,
    spawnImpl = spawn,
    restartMs = 2000,
}) {
    let child = null;
    let retryTimer = null;
    let disposed = false;
    let started = false;
    let status = enabled ? 'waiting' : 'disabled';
    let latest = null;
    const images = new Map();
    let cacheBytes = 0;

    function clearImages() {
        images.clear();
        cacheBytes = 0;
    }

    function retainImage(revision, image) {
        const existing = images.get(revision);
        if (existing) cacheBytes -= existing.length;
        images.delete(revision);
        images.set(revision, image);
        cacheBytes += image.length;
        while (images.size > MAX_CACHED_IMAGES || cacheBytes > MAX_CACHE_BYTES) {
            const oldest = images.keys().next().value;
            cacheBytes -= images.get(oldest).length;
            images.delete(oldest);
        }
    }

    function scheduleRestart() {
        if (disposed || retryTimer) return;
        retryTimer = setTimeout(() => {
            retryTimer = null;
            launch();
        }, restartMs);
        retryTimer.unref?.();
    }

    function launch() {
        if (disposed || !enabled) return;
        status = 'waiting';
        let process;
        try {
            process = spawnImpl('/bin/bash', [
                '-c', 'source "$1" && exec python3 -u "$2"',
                'ros-map-worker', setupPath, WORKER,
            ], { stdio: ['ignore', 'pipe', 'pipe'] });
        } catch (error) {
            status = 'offline';
            logger?.warn({ error: error.message }, 'ROS map worker could not start');
            scheduleRestart();
            return;
        }
        child = process;
        const lines = createInterface({ input: process.stdout });
        lines.on('line', line => {
            if (disposed || child !== process) return;
            try {
                if (line.length > MAX_LINE_CHARS) throw new Error('ROS_MAP_TOO_LARGE');
                const value = JSON.parse(line);
                if (value?.type === 'source_lost') {
                    latest = null;
                    clearImages();
                    status = 'waiting';
                    logger?.warn('ROS /map publisher unavailable');
                    return;
                }
                const next = parseWorkerMap(value);
                latest = next;
                retainImage(next.metadata.revision, next.image);
                status = 'ready';
                logger?.info({ revision: latest.metadata.revision,
                    width: latest.metadata.geometry.width,
                    height: latest.metadata.geometry.height }, 'ROS /map received');
            } catch (error) {
                logger?.warn({ error: error.message }, 'ROS map worker message rejected');
            }
        });
        process.stderr.on('data', data => {
            if (!disposed && child === process) {
                logger?.warn({ detail: String(data).slice(0, 500) }, 'ROS map worker diagnostic');
            }
        });
        process.once('error', error => {
            logger?.warn({ error: error.message }, 'ROS map worker process error');
        });
        process.once('exit', (code, signal) => {
            lines.close();
            if (child !== process) return;
            child = null;
            if (disposed) return;
            latest = null;
            clearImages();
            status = 'offline';
            logger?.warn({ code, signal }, 'ROS map worker stopped');
            scheduleRestart();
        });
    }

    return {
        start() {
            if (started || disposed || !enabled) return;
            started = true;
            launch();
        },
        getMetadata() {
            return latest ? structuredClone(latest.metadata) : { status };
        },
        getImage(revision) {
            return images.get(revision) ?? null;
        },
        dispose() {
            disposed = true;
            if (retryTimer) clearTimeout(retryTimer);
            retryTimer = null;
            child?.kill('SIGTERM');
            child = null;
            latest = null;
            clearImages();
        },
    };
}
