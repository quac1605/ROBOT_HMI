// components/CameraPanel.jsx
import { useEffect, useRef, useState } from 'react';
import { Box, Typography } from '@mui/material';
import { openCameraStream } from '../clients/cameraStreamClient.js';
import { createWhepReader } from '../clients/whepReader.js';

// Props:
// - client: robotClient (có getCameraStream)
// - cameraId: 'front' | 'rear'
// - generation: number — tăng khi switch camera
// - onFrame: ({ cameraId, generation, lastFrameAt }) => void
// - onFailure: ({ cameraId, generation, message }) => void
export default function CameraPanel({ client, cameraId, generation, onFrame, onFailure }) {
    const videoRef = useRef(null);
    const [sourceKind, setSourceKind] = useState(null);

    useEffect(() => {
        const video = videoRef.current;
        let alive = true;
        let closeStream = null;
        setSourceKind(null);

        async function open() {
            try {
                // Query descriptor từ service
                const descriptor = await client.getCameraStream({ cameraId });
                if (!alive) return; // Cleanup đã chạy trong lúc await

                // Validate: descriptor phải đúng camera
                if (descriptor.cameraId !== cameraId) {
                    if (alive) onFailure({ cameraId, generation, message: 'Camera descriptor ID không khớp.' });
                    return;
                }
                setSourceKind(descriptor.kind);

                closeStream = openCameraStream({
                    video,
                    descriptor,
                    createWebRtcReader: createWhepReader,
                    onFrame: lastFrameAt => {
                        if (alive) onFrame({ cameraId, generation, lastFrameAt });
                    },
                    onError: error => {
                        if (alive) onFailure({ cameraId, generation, message: error.message });
                    },
                });
            } catch (error) {
                if (alive) onFailure({ cameraId, generation, message: error.message });
            }
        }

        open();

        // Cleanup: đặt alive=false TRƯỚC rồi mới close
        // Thứ tự này ngăn callback muộn từ stream cũ ghi vào state mới
        return () => {
            alive = false;
            closeStream?.();
        };
    }, [client, cameraId, generation, onFrame, onFailure]);

    return (
        <Box sx={{ position: 'relative', bgcolor: '#000', borderRadius: 2, overflow: 'hidden' }}>
            <video
                ref={videoRef}
                muted
                playsInline
                preload="auto"
                aria-label={`Camera ${cameraId === 'front' ? 'trước' : 'sau'} robot`}
                data-testid={`camera-video-${cameraId}`}
                style={{ width: '100%', height: 'auto', display: 'block', aspectRatio: '16/9' }}
            />
            <Typography
                variant="caption"
                sx={{
                    position: 'absolute', bottom: 8, left: 8,
                    bgcolor: 'rgba(0,0,0,0.6)', color: '#fff', px: 1, borderRadius: 1,
                }}
            >
                {cameraId === 'front' ? 'Trước' : 'Sau'} — {
                    sourceKind === 'webrtc' ? 'Camera ROS trực tiếp' :
                        sourceKind === 'file' ? 'Video mẫu (mô phỏng)' : 'Đang kết nối'
                }
            </Typography>
        </Box>
    );
}
