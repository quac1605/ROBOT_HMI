/** Server-side geometry check; UI validation alone cannot authorize a goal. */
export function assertPosesInsideMap(metadata, poses) {
    if (!metadata.capabilities.canNavigate || metadata.status !== 'ready') {
        throw Object.assign(new Error('MAP_CONTEXT_MISMATCH'), {
            code: 'MAP_CONTEXT_MISMATCH', status: 409,
        });
    }
    const { x: ox, y: oy, yaw } = metadata.origin;
    const c = Math.cos(yaw);
    const s = Math.sin(yaw);
    for (const pose of poses) {
        if (pose.frameId !== metadata.frameId) {
            throw Object.assign(new Error('MAP_CONTEXT_MISMATCH'), {
                code: 'MAP_CONTEXT_MISMATCH', status: 409,
            });
        }
        const dx = pose.x - ox;
        const dy = pose.y - oy;
        const u = (c * dx + s * dy) / metadata.resolution;
        const v = (-s * dx + c * dy) / metadata.resolution;
        // Match the 2D viewer's tolerance at the lower edge; top/right edges
        // remain excluded so a goal cannot target a cell outside the grid.
        if (!(u >= -1e-9 && u < metadata.width &&
              v >= -1e-9 && v < metadata.height)) {
            throw Object.assign(new Error('POSE_OUTSIDE_MAP'), {
                code: 'POSE_OUTSIDE_MAP', status: 400,
            });
        }
    }
}
