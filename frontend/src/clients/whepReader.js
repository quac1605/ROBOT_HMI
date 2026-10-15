/**
 * @file [READ FLOW STEP 11] Đàm phán một phiên xem video với MediaMTX bằng WHEP.
 * WHEP dùng HTTP để trao đổi SDP (codec, hướng truyền, địa chỉ ICE); hình ảnh sau
 * đó đi qua WebRTC, không nằm trong HTTP response hay WebSocket telemetry.
 * Mỗi CameraPanel sở hữu một reader và phải đóng reader khi đổi camera/rời trang.
 * Đây là client nhận video; không xin microphone/camera của máy người xem.
 */

/**
 * Tạo PeerConnection và bắt đầu đàm phán bất đồng bộ ngay khi được gọi.
 * @param {object} options Cấu hình nhận từ descriptor do backend cấp.
 * @param {string} options.url WHEP endpoint của đúng camera được chọn.
 * @param {string} [options.token] Grant ngắn hạn, gửi qua Bearer header, không qua URL.
 * @param {(stream: MediaStream) => void} options.onStream Nhận stream khi có track;
 * có track chưa chứng minh trình duyệt đã hiển thị được một frame.
 * @param {(error: Error) => void} options.onError Nhận lỗi đàm phán/ICE bất đồng bộ.
 * @returns {{close: () => void}} Handle đóng phiên; close gọi nhiều lần vẫn an toàn.
 * @throws {Error} Khởi tạo RTCPeerConnection có thể ném đồng bộ nếu môi trường
 * không hỗ trợ; lớp openCameraStream bên ngoài chịu trách nhiệm bắt lỗi này.
 */
export function createWhepReader({ url, token, onStream, onError }) {
  // Không cấu hình STUN/TURN: ICE cần candidate host có thể truy cập trực tiếp.
  // URL HTTPS truy cập được chưa chứng minh đường UDP media đã thông (nhất là LAN).
  const pc = new RTCPeerConnection({ iceServers: [] });
  const abort = new AbortController();
  let closed = false;
  let sessionUrl = null;
  let stream = null;
  let phase = 'OFFER';
  const headers = token ? { Authorization: `Bearer ${token}` } : {};
  // Hạn chờ này bảo vệ bước đàm phán; được hủy khi đặt SDP answer thành công.
  // Nó không phải thời hạn chờ frame đầu tiên và cũng không đo tuổi ảnh ROS.
  const timeout = setTimeout(() => fail(new Error('CAMERA_WHEP_TIMEOUT')), 15_000);

  /**
   * Chặn callback muộn trước khi giải phóng tài nguyên của phiên.
   * @returns {void} DELETE là best effort, không chờ mạng để hoàn tất cleanup UI.
   */
  function close() {
    if (closed) return;
    closed = true;
    clearTimeout(timeout);
    abort.abort();
    pc.close();
    for (const track of stream?.getTracks?.() ?? []) track.stop();
    if (sessionUrl) {
      // Chỉ DELETE khi đã biết URL phiên. Nếu DELETE thất bại, MediaMTX còn có
      // cơ chế thu hồi khi peer mất kết nối; cleanup phía browser vẫn hoàn tất.
      void fetch(sessionUrl, { method: 'DELETE', headers, credentials: 'omit' })
        .catch(() => {});
    }
  }

  /**
   * Đóng trước, báo lỗi sau: callback UI không được tiếp tục dùng peer đã lỗi.
   * @param {Error} error Nguyên nhân cần báo cho CameraPanel.
   * @returns {void}
   */
  function fail(error) {
    if (closed) return;
    close();
    onError(error);
  }

  /** @param {RTCTrackEvent} event Track WebRTC vừa đến; gom thành stream cho <video>. */
  pc.ontrack = event => {
    if (closed) return;
    stream = event.streams[0] ?? new MediaStream([event.track]);
    onStream(stream);
  };
  /** @returns {void} ICE/DTLS thất bại phải kết thúc reader, không giả báo đang phát. */
  pc.onconnectionstatechange = () => {
    if (pc.connectionState === 'failed' && !closed) fail(new Error('CAMERA_ICE_FAILED'));
  };

  /**
   * Thu thập candidate, POST offer rồi áp dụng answer để WebRTC tìm đường media.
   * @returns {Promise<void>} Lỗi trong chuỗi await được chuyển sang onError;
   * hủy do chủ sở hữu close() thì bỏ qua, tránh báo lỗi cho camera mới.
   */
  async function connect() {
    try {
      phase = 'OFFER';
      pc.addTransceiver('video', { direction: 'recvonly' });
      await pc.setLocalDescription(await pc.createOffer());
      // Chờ đủ ICE candidate trước POST để không cần PATCH/trickle ICE sau đó.
      // Đổi lại thời gian khởi động gồm cả thời gian thu thập candidate.
      if (pc.iceGatheringState !== 'complete') {
        await new Promise((resolve, reject) => {
          /** @returns {void} Hoàn tất chờ khi browser đã thu thập xong candidate. */
          const onState = () => {
            if (pc.iceGatheringState === 'complete') {
              pc.removeEventListener('icegatheringstatechange', onState);
              resolve();
            }
          };
          pc.addEventListener('icegatheringstatechange', onState);
          abort.signal.addEventListener('abort', () => reject(new Error('CAMERA_CLOSED')),
            { once: true });
        });
      }
      if (closed) return;
      phase = 'SIGNALING';
      const response = await fetch(url, {
        method: 'POST',
        headers: { ...headers, 'Content-Type': 'application/sdp' },
        body: pc.localDescription.sdp,
        // Media server dùng grant Bearer riêng; không gửi cookie session HMI.
        credentials: 'omit',
        redirect: 'error',
        signal: abort.signal,
      });
      if (response.status !== 201) throw new Error(`CAMERA_WHEP_HTTP_${response.status}`);
      const location = response.headers.get('Location');
      if (!location) throw new Error('CAMERA_WHEP_NO_SESSION');
      const resolved = new URL(location, url);
      // Location chỉ được trỏ cùng origin: không để server response chuyển
      // Authorization header của DELETE sang một máy chủ khác.
      if (resolved.origin !== new URL(url).origin) throw new Error('CAMERA_WHEP_CROSS_ORIGIN_SESSION');
      sessionUrl = resolved.href;
      phase = 'ANSWER_BODY';
      const answer = await response.text();
      if (closed) return;
      phase = 'REMOTE_DESCRIPTION';
      await pc.setRemoteDescription({ type: 'answer', sdp: answer });
      clearTimeout(timeout);
    } catch (error) {
      if (!closed) {
        // Gắn tên bước lỗi để phân biệt HTTPS/CORS với ICE; không chủ động ghép
        // grant, URL yêu cầu hay toàn bộ SDP vào thông báo hiển thị cho người dùng.
        fail(new Error(`CAMERA_WHEP_${phase}: ${error.message}`, { cause: error }));
      }
    }
  }

  void connect();
  return { close };
}
