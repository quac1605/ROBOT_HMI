/**
 * packages/contracts/src/apiManifest.js
 * 
 * BẢN ĐÓNG BĂNG MANIFEST HỢP ĐỒNG API VÀ SỰ KIỆN GIỮA FRONTEND VÀ BACKEND (M2).
 * 
 * Quy tắc:
 * 1. Chỉ chứa metadata và cấu hình đường truyền (path, method, event type, status code).
 * 2. TUYỆT ĐỐI KHÔNG import Express, React, hay các logic xử lý nghiệp vụ tại đây.
 * 3. Dữ liệu được Object.freeze sâu để chống sửa đổi ngẫu nhiên ở runtime.
 */

export const API_MANIFEST = Object.freeze({
  // ==========================================
  // 1. AUTHENTICATION & SESSION MANAGEMENT
  // ==========================================
  login: Object.freeze({
    type: 'http',
    method: 'POST',
    path: '/api/auth/login',
    successStatus: 200,
    description: 'Xác thực tài khoản admin, khởi tạo session cookie và xoay SID an toàn.',
  }),
  getSession: Object.freeze({
    type: 'http',
    method: 'GET',
    path: '/api/auth/session',
    successStatus: 200,
    description: 'Lấy phiên đăng nhập hiện tại; riêng HTTP 401 trả về { user: null }.',
  }),
  logout: Object.freeze({
    type: 'http',
    method: 'POST',
    path: '/api/auth/logout',
    successStatus: 204,
    description: 'Thu hồi quyền lái, hủy session cookie và dọn dẹp socket.',
  }),
  getCsrf: Object.freeze({
    type: 'http',
    method: 'GET',
    path: '/api/auth/csrf',
    successStatus: 200,
    description: 'Lấy CSRF token cho phiên trước khi gửi các POST/PUT/DELETE.',
  }),

  // ==========================================
  // 2. ROBOT STATE & TELEMETRY
  // ==========================================
  getRobotState: Object.freeze({
    type: 'http',
    method: 'GET',
    path: '/api/robot/state',
    successStatus: 200,
    description: 'Snapshot trạng thái tổng thể của robot.',
  }),
  subscribeRobotState: Object.freeze({
    type: 'ws',
    channel: '/ws',
    eventType: 'robot.state',
    description: 'Stream cập nhật trạng thái robot định kỳ qua WebSocket.',
  }),

  // ==========================================
  // 3. MAP MANAGEMENT & 2D OCCUPANCY GRID
  // ==========================================
  listMaps: Object.freeze({
    type: 'http',
    method: 'GET',
    path: '/api/maps',
    successStatus: 200,
    description: 'Danh sách metadata các bản đồ đã lưu.',
  }),
  getMap: Object.freeze({
    type: 'http',
    method: 'GET',
    path: '/api/maps/:id',
    successStatus: 200,
    description: 'Chi tiết metadata bản đồ kèm mapRevision bất biến.',
  }),
  getMapGrid: Object.freeze({
    type: 'http',
    method: 'GET',
    path: '/api/map-grid',
    successStatus: 200,
    description: 'Snapshot lưới ô vuông (OccupancyGrid) theo context (saved hoặc mapping).',
  }),
  subscribeMapGrid: Object.freeze({
    type: 'ws',
    channel: '/map-stream',
    eventType: 'map.grid',
    description: 'Kênh riêng truyền tải dữ liệu bản đồ dạng nhị phân/JSON tối đa 2 MiB.',
  }),

  // ==========================================
  // 4. MAPPING WORKFLOW & JOBS
  // ==========================================
  getActiveMappingSession: Object.freeze({
    type: 'http',
    method: 'GET',
    path: '/api/mapping/sessions/active',
    successStatus: 200,
    description: 'Kiểm tra phiên quét bản đồ đang hoạt động (duy nhất 1 phiên toàn cục).',
  }),
  startMapping: Object.freeze({
    type: 'http',
    method: 'POST',
    path: '/api/mapping/start',
    successStatus: 200,
    description: 'Bắt đầu quét bản đồ mới, nhận jobId và mappingSessionId.',
  }),
  finishMapping: Object.freeze({
    type: 'http',
    method: 'POST',
    path: '/api/mapping/finish',
    successStatus: 200,
    description: 'Kết thúc quét và bắt đầu xử lý lưu bản đồ thành asset bền vững.',
  }),
  getJob: Object.freeze({
    type: 'http',
    method: 'GET',
    path: '/api/jobs/:id',
    successStatus: 200,
    description: 'Tra cứu trạng thái job bất đồng bộ.',
  }),
  subscribeJobs: Object.freeze({
    type: 'ws',
    channel: '/ws',
    eventType: 'job.updated',
    description: 'Sự kiện cập nhật tiến trình của Job (mapping, activation, preview).',
  }),
  activateMap: Object.freeze({
    type: 'http',
    method: 'POST',
    path: '/api/maps/activate',
    successStatus: 200,
    description: 'Kích hoạt bản đồ đã lưu để điều hướng.',
  }),

  // ==========================================
  // 5. ROUTES & MISSIONS (NAVIGATION)
  // ==========================================
  previewRoute: Object.freeze({
    type: 'http',
    method: 'POST',
    path: '/api/routes/preview',
    successStatus: 200,
    description: 'Tạo đường đi minh họa trước khi chạy hoặc lưu.',
  }),
  saveRoute: Object.freeze({
    type: 'http',
    method: 'POST',
    path: '/api/routes',
    successStatus: 200,
    description: 'Lưu lộ trình waypoint gắn liền với mapId và mapRevision.',
  }),
  listRoutes: Object.freeze({
    type: 'http',
    method: 'GET',
    path: '/api/routes',
    successStatus: 200,
    description: 'Lấy danh sách lộ trình theo mapId & mapRevision.',
  }),
  createMission: Object.freeze({
    type: 'http',
    method: 'POST',
    path: '/api/missions',
    successStatus: 200,
    description: 'Tạo nhiệm vụ điều hướng (1 điểm hoặc qua nhiều điểm).',
  }),
  getActiveMission: Object.freeze({
    type: 'http',
    method: 'GET',
    path: '/api/missions/active',
    successStatus: 200,
    description: 'Lấy nhiệm vụ đang thực thi (phải route trước /:id).',
  }),
  getMission: Object.freeze({
    type: 'http',
    method: 'GET',
    path: '/api/missions/:id',
    successStatus: 200,
    description: 'Chi tiết nhiệm vụ theo missionId.',
  }),
  cancelMission: Object.freeze({
    type: 'http',
    method: 'POST',
    path: '/api/missions/:id/cancel',
    successStatus: 200,
    description: 'Hủy nhiệm vụ điều hướng đang chạy.',
  }),
  getOriginalPosition: Object.freeze({
    type: 'http',
    method: 'GET',
    path: '/api/navigation/original-position',
    successStatus: 200,
    description: 'Vị trí ban đầu của robot (x, y, theta rad) dùng cho mode auto; null khi chưa nhập.',
  }),
  setOriginalPosition: Object.freeze({
    type: 'http',
    method: 'PUT',
    path: '/api/navigation/original-position',
    successStatus: 200,
    description: 'Đặt hoặc cập nhật ước lượng vị trí robot trước nhiệm vụ AUTO; trả 409 ORIGINAL_POSITION_DURING_MISSION khi đang chạy nhiệm vụ.',
  }),
  setTarget: Object.freeze({
    type: 'http', method: 'PUT', path: '/api/navigation/target', successStatus: 200,
    description: 'Cập nhật ngay danh sách đích PoseStamped của /cmd_in trong mode AUTO.',
  }),
  subscribeMissions: Object.freeze({
    type: 'ws',
    channel: '/ws',
    eventType: 'mission.updated',
    description: 'Cập nhật tiến trình thực thi nhiệm vụ theo thời gian thực.',
  }),
  subscribeNavigationPath: Object.freeze({
    type: 'ws',
    channel: '/ws',
    eventType: 'navigation.path',
    description: 'Stream đường dẫn tọa độ thực tế của robot khi đang chạy mission.',
  }),

  // ==========================================
  // 6. CAMERA SUBSYSTEM
  // ==========================================
  listCameras: Object.freeze({
    type: 'http',
    method: 'GET',
    path: '/api/cameras',
    successStatus: 200,
    description: 'Danh sách camera khả dụng (front và rear). Trả về Array.',
  }),
  getCameraStream: Object.freeze({
    type: 'http',
    method: 'GET',
    path: '/api/cameras/:cameraId/stream',
    successStatus: 200,
    description: 'Lấy descriptor stream video của camera (file MP4 mock hoặc WebRTC URL).',
  }),

  // ==========================================
  // 7. MOTION CONTROL & TELEOPERATION
  // ==========================================
  acquireControl: Object.freeze({
    type: 'http',
    method: 'POST',
    path: '/api/control/lease',
    successStatus: 200,
    description: 'Đăng ký quyền lái kèm binding tab (X-HMI-Connection-Id, X-HMI-Owner-Token).',
  }),
  releaseControl: Object.freeze({
    type: 'http',
    method: 'POST',
    path: '/api/control/release',
    successStatus: 200,
    description: 'Chủ động trả quyền lái của tab hiện tại.',
  }),
  requestStop: Object.freeze({
    type: 'http',
    method: 'POST',
    path: '/api/control/stop',
    successStatus: 202, // QUAN TRỌNG: 202 Accepted (ghi nhận yêu cầu, chưa xác nhận dừng vật lý)
    description: 'Yêu cầu dừng khẩn cấp/an toàn. Chấp nhận từ bất kỳ session hợp lệ nào.',
  }),
  getControlState: Object.freeze({
    type: 'http',
    method: 'GET',
    path: '/api/control/state',
    successStatus: 200,
    description: 'Lấy snapshot quyền điều khiển (chỉ owner thấy lease; observer nhận view rút gọn).',
  }),
  subscribeControl: Object.freeze({
    type: 'ws',
    channel: '/ws',
    eventType: 'control.*',
    description: 'Lắng nghe các sự kiện kiểm soát: snapshot, granted, revoked, heartbeat, stopConfirmed.',
  }),
  sendVelocity: Object.freeze({
    type: 'ws',
    channel: '/ws',
    eventType: 'teleop.velocity',
    description: 'Gửi vận tốc qua WebSocket dạng đồng bộ (không async, không promise).',
  }),

  // ==========================================
  // 8. LOCAL CLIENT UTILITIES
  // ==========================================
  subscribeConnectionStatus: Object.freeze({
    type: 'client',
    description: 'Theo dõi trạng thái kết nối mạng (connecting, connected, disconnected) và profile.',
  }),
  dispose: Object.freeze({
    type: 'client',
    description: 'Giải phóng toàn bộ tài nguyên kết nối, dọn dẹp timer và listener.',
  }),
});
