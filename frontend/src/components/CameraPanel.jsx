/**
 * @file [READ FLOW STEP 13] Vòng đời camera ở giao diện React.
 * Component xin descriptor qua RobotClient rồi giao playback cho cameraStreamClient.
 * Nó không chọn camera theo hướng robot: cameraId do người dùng/lớp cha quyết định.
 * generation cùng cameraId giúp lớp cha nhận ra callback thuộc lần chọn camera nào.
 */
import { useEffect, useRef, useState } from 'react';
import { Box, Typography } from '@mui/material';
import { openCameraStream } from '../clients/cameraStreamClient.js';
import { createWhepReader } from '../clients/whepReader.js';

/**
 * Hiển thị một nguồn video; nhãn nguồn không thay thế kiểm tra frame freshness.
 * @param {object} props Thuộc tính do Navigation/Mapping truyền vào.
 * @param {object} props.client RobotClient có getCameraStream({ cameraId }).
 * @param {'front'|'rear'} props.cameraId Camera được chọn độc lập với hướng lái.
 * @param {number} props.generation Phiên lựa chọn; tăng khi chuyển/reset camera.
 * @param {(frame: object) => void} props.onFrame Nhận cameraId, generation, lastFrameAt.
 * @param {(failure: object) => void} props.onFailure Nhận cameraId, generation, message.
 * @returns {import('react').ReactElement} Khung video và nhãn nguồn đang dùng.
 * Lỗi lấy descriptor/mở stream đi qua onFailure; callback của lớp cha cần ổn định
 * (ví dụ useCallback) vì đổi identity callback cũng khởi động lại effect này.
 */
export default function CameraPanel({ client, cameraId, generation, onFrame, onFailure }) {
    const videoRef = useRef(null);
    const [sourceKind, setSourceKind] = useState(null);

    /**
     * Mỗi lần effect chạy sở hữu một phiên độc lập; cleanup trước khi mở phiên khác.
     * @returns {() => void} Hàm React gọi khi đổi dependency hoặc unmount.
     */
    useEffect(() => {
        const video = videoRef.current;
        let alive = true;
        let closeStream = null;
        setSourceKind(null);

        /**
         * Xin descriptor sau auth, kiểm tra camera rồi mới tạo kết nối video.
         * @returns {Promise<void>} Lỗi được báo cho lớp cha, không ném ra React render.
         */
        async function open() {
            try {
                // Remote trả WHEP URL + grant ngắn hạn; mock trả URL file demo.
                // Descriptor chứa quyền truy cập, chưa chứa frame/video thực tế.
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
                    /** @param {number} lastFrameAt Browser presentation time, không phải ROS stamp. */
                    onFrame: lastFrameAt => {
                        if (alive) onFrame({ cameraId, generation, lastFrameAt });
                    },
                    /** @param {Error} error Chỉ báo về phiên UI còn sống. */
                    onError: error => {
                        if (alive) onFailure({ cameraId, generation, message: error.message });
                    },
                });
            } catch (error) {
                if (alive) onFailure({ cameraId, generation, message: error.message });
            }
        }

        open();

        // alive thuộc closure của effect cũ: response HTTP hoặc frame tới muộn
        // không thể cập nhật health của lần chọn mới. Cleanup cũng cần an toàn
        // khi React StrictMode mount/cleanup lại component lúc phát triển.
        /** @returns {void} Khóa callback rồi đóng reader và reset video. */
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
