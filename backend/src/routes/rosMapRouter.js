import { Router } from 'express';

export function createRosMapRouter({ lifecycle, rosMapService }) {
    const router = Router();

    router.get('/ros-map', lifecycle.requireAuth, (_req, res) => {
        res.status(200).json(rosMapService.getMetadata());
    });

    router.get('/ros-map/image', lifecycle.requireAuth, (req, res) => {
        const revision = req.query.revision;
        if (typeof revision !== 'string' || !/^[a-f0-9]{32}$/.test(revision)) {
            res.status(400).json({ error: { code: 'INVALID_MAP_REVISION',
                message: 'Map revision không hợp lệ' } });
            return;
        }
        const image = rosMapService.getImage(revision);
        if (!image) {
            res.status(409).json({ error: { code: 'ROS_MAP_CHANGED',
                message: 'Bản đồ đã thay đổi hoặc chưa sẵn sàng' } });
            return;
        }
        res.setHeader('Content-Type', 'image/png');
        res.setHeader('Content-Length', image.length);
        res.status(200).end(image);
    });

    return router;
}
