/** Resolve a 2D odometry pose into the current map frame using ROS TF messages. */

const MAX_TRANSFORMS = 256;
const MAX_HOPS = 32;

function frameId(value) {
    if (typeof value !== 'string') return null;
    const normalized = value.trim().replace(/^\/+/, '');
    return normalized && normalized.length <= 128 ? normalized : null;
}

function yawFromQuaternion(q) {
    if (![q?.x, q?.y, q?.z, q?.w].every(Number.isFinite)) return null;
    const norm = Math.hypot(q.x, q.y, q.z, q.w);
    if (!Number.isFinite(norm) || norm < 1e-8) return null;
    const [x, y, z, w] = [q.x / norm, q.y / norm, q.z / norm, q.w / norm];
    const roll = Math.atan2(2 * (w * x + y * z), 1 - 2 * (x * x + y * y));
    const pitch = Math.asin(Math.max(-1, Math.min(1, 2 * (w * y - z * x))));
    if (Math.abs(roll) > 1e-3 || Math.abs(pitch) > 1e-3) return null;
    return Math.atan2(2 * (w * z + x * y), 1 - 2 * (y * y + z * z));
}

function normalizeYaw(yaw) {
    return Math.atan2(Math.sin(yaw), Math.cos(yaw));
}

function compose(a, b) {
    const c = Math.cos(a.yaw);
    const s = Math.sin(a.yaw);
    return {
        x: a.x + c * b.x - s * b.y,
        y: a.y + s * b.x + c * b.y,
        yaw: normalizeYaw(a.yaw + b.yaw),
    };
}

function inverse(t) {
    const c = Math.cos(t.yaw);
    const s = Math.sin(t.yaw);
    return {
        x: -c * t.x - s * t.y,
        y: s * t.x - c * t.y,
        yaw: normalizeYaw(-t.yaw),
    };
}

function parseTransform(stamped, receivedAt) {
    const parent = frameId(stamped?.header?.frame_id);
    const child = frameId(stamped?.child_frame_id);
    const t = stamped?.transform?.translation;
    const yaw = yawFromQuaternion(stamped?.transform?.rotation);
    if (!parent || !child || parent === child ||
        !Number.isFinite(t?.x) || !Number.isFinite(t?.y) ||
        !Number.isFinite(t?.z) || yaw === null) return null;
    return { parent, child, x: t.x, y: t.y, yaw, receivedAt };
}

/**
 * TF stores T_parent_child. Dynamic edges expire on arrival age; static edges
 * last only for the current rosbridge connection. No frame guess is made.
 */
export function createRosTfResolver({ now = () => performance.now(), maxDynamicAgeMs = 1500 } = {}) {
    const dynamic = new Map();
    const staticTransforms = new Map();

    function ingest(message, { isStatic = false } = {}) {
        if (!Array.isArray(message?.transforms)) return 0;
        const target = isStatic ? staticTransforms : dynamic;
        const receivedAt = now();
        let accepted = 0;
        for (const stamped of message.transforms.slice(0, MAX_TRANSFORMS)) {
            const transform = parseTransform(stamped, receivedAt);
            if (!transform) continue;
            const key = `${transform.parent}\0${transform.child}`;
            target.delete(key);
            target.set(key, transform);
            if (target.size > MAX_TRANSFORMS) target.delete(target.keys().next().value);
            accepted++;
        }
        return accepted;
    }

    function resolvePose(pose, targetFrameId) {
        const source = frameId(pose?.frameId);
        const target = frameId(targetFrameId);
        if (!source || !target || ![pose?.x, pose?.y, pose?.yaw].every(Number.isFinite)) return null;
        if (source === target) return { frameId: targetFrameId, x: pose.x, y: pose.y, yaw: pose.yaw };

        const fresh = new Map(staticTransforms);
        const at = now();
        for (const [key, edge] of dynamic) {
            if (at - edge.receivedAt <= maxDynamicAgeMs) fresh.set(key, edge);
        }
        const adjacency = new Map();
        const add = (from, to, transform) => {
            if (!adjacency.has(from)) adjacency.set(from, []);
            adjacency.get(from).push({ to, transform });
        };
        for (const edge of fresh.values()) {
            // Parent <- child is direct; child <- parent is its inverse.
            add(edge.child, edge.parent, edge);
            add(edge.parent, edge.child, inverse(edge));
        }

        const visited = new Set([source]);
        const queue = [{ frame: source, transform: { x: 0, y: 0, yaw: 0 }, hops: 0 }];
        for (let head = 0; head < queue.length; head++) {
            const item = queue[head];
            if (item.hops >= MAX_HOPS) continue;
            for (const step of adjacency.get(item.frame) ?? []) {
                if (visited.has(step.to)) continue;
                const transform = compose(step.transform, item.transform);
                if (![transform.x, transform.y, transform.yaw].every(Number.isFinite)) continue;
                if (step.to === target) {
                    const result = compose(transform, pose);
                    if (![result.x, result.y, result.yaw].every(Number.isFinite)) continue;
                    return { frameId: targetFrameId, ...result };
                }
                visited.add(step.to);
                queue.push({ frame: step.to, transform, hops: item.hops + 1 });
            }
        }
        return null;
    }

    return {
        ingest,
        resolvePose,
        clear() { dynamic.clear(); staticTransforms.clear(); },
    };
}
