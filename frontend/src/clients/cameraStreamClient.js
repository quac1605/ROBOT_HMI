/**
 * @file [READ FLOW STEP 12] Nối nguồn camera với một HTMLVideoElement.
 * Lớp này thống nhất video mẫu và WebRTC, theo dõi frame được trình bày, đồng
 * thời sở hữu cleanup. Một video element chỉ được một instance sử dụng tại một
 * thời điểm; CameraPanel đóng instance cũ trước khi mở nguồn mới.
 */

/**
 * Mở nguồn video và trả ngay hàm cleanup để React quản lý vòng đời.
 * @param {object} options Các phụ thuộc được truyền vào để test không cần camera thật.
 * @param {HTMLVideoElement} options.video Phần tử sẽ nhận src hoặc srcObject.
 * @param {object} options.descriptor DTO camera đã được RobotClient kiểm tra schema.
 * @param {Function|null} [options.createWebRtcReader] Factory nhận url/token/callback,
 * trả handle có close(); null khiến descriptor WebRTC bị từ chối.
 * @param {(lastFrameAt: number) => void} options.onFrame Thời điểm browser trình
 * bày frame theo performance.now(), cùng miền đồng hồ với kiểm tra freshness UI.
 * @param {(error: Error) => void} options.onError Lỗi nguồn/API/playback; stream được đóng trước.
 * @param {(error: Error) => void} [options.onCleanupError] Lỗi reader.close() cần ghi nhận.
 * @returns {() => void} close đồng bộ, idempotent; caller phải gọi khi bỏ nguồn.
 * @throws {Error} Lỗi callback do caller cung cấp hoặc DOM cleanup vẫn có thể
 * truyền ra ngoài; lỗi mở nguồn thông thường được chuyển qua onError.
 */
export function openCameraStream({
    video,
    descriptor,
    createWebRtcReader = null, // CameraPanel truyền createWhepReader ở runtime hiện tại.
    onFrame,                   // (lastFrameAt: number) => void — monotonic timestamp
    onError,                   // (error: Error) => void
    onCleanupError = () => { }, // Lỗi khi close reader (không crash main flow)
}) {
    let alive = true;
    let frameId = null;
    let reader = null;
    let mediaStream = null;

    /**
     * Dừng track để stream đến muộn không giữ tài nguyên sau khi component rời trang.
     * @param {MediaStream|null} stream Nguồn cần giải phóng, có thể chưa được tạo.
     * @returns {void}
     */
    const stopTracks = stream => {
        for (const track of stream?.getTracks?.() ?? []) track.stop();
    };

    /**
     * Hủy frame callback, reader và liên kết media với DOM theo một lần duy nhất.
     * @returns {void} alive=false được đặt trước mọi thao tác có thể phát callback.
     */
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

    /**
     * Chuẩn hóa lỗi và báo cho UI sau khi nguồn đã bị đóng.
     * @param {unknown} error Lỗi từ reader, play() hoặc kiểm tra descriptor.
     * @returns {void}
     */
    const fail = error => {
        if (!alive) return;
        close(); // Đóng trước khi báo lỗi để không hồi sinh sau lỗi
        onError(error instanceof Error ? error : new Error(String(error)));
    };

    /** @returns {void} Chuyển DOM media error sang cùng luồng xử lý lỗi của reader. */
    function mediaError() { fail(new Error('CAMERA_MEDIA_ERROR')); }

    /**
     * Đánh dấu browser vừa nhận một frame để trình bày, rồi đăng ký lần kế tiếp.
     * @returns {void}
     * Không dùng timer/polling currentTime: timer vẫn chạy khi hình đã đứng.
     * requestVideoFrameCallback không đảm bảo nhận callback cho mọi frame; đây
     * cũng không phải timestamp camera chụp ảnh. Nguồn phát lại ảnh cũ thành
     * frame mới vẫn có callback, nên cơ chế này không chứng minh tuổi ảnh ROS.
     */
    const frame = () => {
        if (!alive) return;
        onFrame(performance.now()); // Đồng hồ đơn điệu của browser, không phải ROS time.
        if (alive) frameId = video.requestVideoFrameCallback(frame);
    };

    /**
     * Bắt cả lỗi đồng bộ và Promise reject (ví dụ chính sách autoplay của browser).
     * @returns {void} Playback thất bại phải xóa health, không giữ trạng thái frame cũ.
     */
    const play = () => {
        if (!alive) return;
        /** @param {Error} error Lỗi play(); thêm ngữ cảnh mà vẫn giữ nguyên cause. */
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
                /**
                 * @param {MediaStream} stream Track tới bất đồng bộ, có thể sau cleanup.
                 * @returns {void} srcObject nhận trực tiếp MediaStream, không tạo base64 ảnh.
                 */
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
            // Factory có thể gọi onError đồng bộ trước khi trả handle: fail()
            // khi đó chưa biết reader; đóng handle vừa trả để không rò kết nối.
            if (!alive) reader.close();
        } else {
            throw new Error('CAMERA_KIND_UNSUPPORTED');
        }
    } catch (e) { fail(e); }

    return close;
}
