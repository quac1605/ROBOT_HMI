// clients/cameraStreamClient.js
// Trả về hàm close() để CameraPanel gọi trong cleanup của useEffect.
// Mỗi video element chỉ thuộc một instance duy nhất.
export function openCameraStream({
    video,
    descriptor,
    createWebRtcReader = null, // Inject factory WebRTC (Chặng 9). null = chưa hỗ trợ.
    onFrame,                   // (lastFrameAt: number) => void — monotonic timestamp
    onError,                   // (error: Error) => void
    onCleanupError = () => { }, // Lỗi khi close reader (không crash main flow)
}) {
    let alive = true;
    let frameId = null;
    let reader = null;
    let mediaStream = null;

    const stopTracks = stream => {
        for (const track of stream?.getTracks?.() ?? []) track.stop();
    };

    // close(): idempotent, đồng bộ
    const close = () => {
        if (!alive) return;
        alive = false;
        if (frameId !== null) video.cancelVideoFrameCallback?.(frameId);
        video.removeEventListener('error', mediaError);
        try { reader?.close(); } catch (e) { onCleanupError(e); }
        stopTracks(mediaStream);
        mediaStream = null;
        video.pause();
        video.removeAttribute('src');
        video.srcObject = null;
        video.load(); // Reset media element
    };

    const fail = error => {
        if (!alive) return;
        close(); // Đóng trước khi báo lỗi để không hồi sinh sau lỗi
        onError(error instanceof Error ? error : new Error(String(error)));
    };

    function mediaError() { fail(new Error('CAMERA_MEDIA_ERROR')); }

    // Frame callback: mỗi frame compositor decode được
    const frame = () => {
        if (!alive) return;
        onFrame(performance.now()); // Thời điểm frame HIỆN TẠI theo monotonic clock
        if (alive) frameId = video.requestVideoFrameCallback(frame);
    };

    const play = () => {
        if (!alive) return;
        const reportPlayError = error => {
            fail(new Error(`CAMERA_VIDEO_PLAY: ${error.message}`, { cause: error }));
        };
        try { Promise.resolve(video.play()).catch(reportPlayError); }
        catch (e) { reportPlayError(e); }
    };

    video.addEventListener('error', mediaError);

    try {
        // Kiểm tra API frame freshness — không có API này → fail closed
        if (typeof video.requestVideoFrameCallback !== 'function') {
            throw new Error('FRAME_API_UNSUPPORTED');
        }
        frameId = video.requestVideoFrameCallback(frame);

        if (descriptor.kind === 'file') {
            video.loop = true;
            video.src = descriptor.url;
            play();
        } else if (descriptor.kind === 'webrtc') {
            if (!createWebRtcReader) throw new Error('WEBRTC_READER_NOT_CONFIGURED');
            video.loop = false;
            const openedReader = createWebRtcReader({
                url: descriptor.whepUrl,
                token: descriptor.grantToken,
                onStream: stream => {
                    if (!alive) { stopTracks(stream); return; }
                    if (!stream?.getTracks) { fail(new Error('INVALID_MEDIA_STREAM')); return; }
                    if (mediaStream && mediaStream !== stream) stopTracks(mediaStream);
                    mediaStream = stream;
                    video.srcObject = stream;
                    play();
                },
                onError: fail,
            });
            reader = openedReader;
            if (!reader || typeof reader.close !== 'function') {
                throw new Error('INVALID_WEBRTC_READER');
            }
            if (!alive) reader.close(); // Factory gọi error đồng bộ trước return
        } else {
            throw new Error('CAMERA_KIND_UNSUPPORTED');
        }
    } catch (e) { fail(e); }

    return close;
}
