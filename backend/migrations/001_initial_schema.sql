-- backend/migrations/001_initial_schema.sql
-- SCHEMA CƠ SỞ DỮ LIỆU CỐT LÕI HỆ THỐNG ROBOT HMI (M4)

-- 1. BẢNG NGƯỜI DÙNG (USERS)
CREATE TABLE IF NOT EXISTS users (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  username TEXT UNIQUE NOT NULL CHECK (length(username) BETWEEN 3 AND 64),
  password_hash TEXT NOT NULL,
  enabled BOOLEAN NOT NULL DEFAULT true,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- 2. BẢNG PHIÊN ĐĂNG NHẬP (CONNECT-PG-SIMPLE SESSION)
CREATE TABLE IF NOT EXISTS "session" (
  "sid" VARCHAR NOT NULL COLLATE "default" PRIMARY KEY,
  "sess" JSON NOT NULL,
  "expire" TIMESTAMP(6) NOT NULL
);
CREATE INDEX IF NOT EXISTS "IDX_session_expire" ON "session" ("expire");

-- 3. BẢNG BẢN ĐỒ (MAPS)
CREATE TABLE IF NOT EXISTS maps (
  id TEXT PRIMARY KEY CHECK (length(id) BETWEEN 1 AND 128),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- 4. BẢNG PHIÊN BẢN BẢN ĐỒ BẤT BIẾN (MAP_REVISIONS)
CREATE TABLE IF NOT EXISTS map_revisions (
  map_id TEXT NOT NULL REFERENCES maps(id) ON DELETE CASCADE,
  revision TEXT NOT NULL CHECK (length(revision) BETWEEN 1 AND 128),
  name TEXT NOT NULL CHECK (length(name) BETWEEN 1 AND 120),
  status TEXT NOT NULL CHECK (status IN ('creating', 'ready', 'failed')),
  metadata JSONB NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (map_id, revision)
);

-- 5. BẢNG QUẢN LÝ TÀI NGUYÊN FILE BẢN ĐỒ (MAP_ASSETS)
CREATE TABLE IF NOT EXISTS map_assets (
  id TEXT PRIMARY KEY,
  map_id TEXT NOT NULL,
  revision TEXT NOT NULL,
  asset_kind TEXT NOT NULL CHECK (asset_kind IN ('grid_json', 'yaml_meta', 'preview_png')),
  storage_key TEXT NOT NULL UNIQUE, -- Đường dẫn tương đối do server sinh
  sha256 TEXT NOT NULL CHECK (length(sha256) = 64),
  byte_count BIGINT NOT NULL CHECK (byte_count >= 0),
  status TEXT NOT NULL CHECK (status IN ('staging', 'ready', 'failed')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  FOREIGN KEY (map_id, revision) REFERENCES map_revisions(map_id, revision) ON DELETE CASCADE
);

-- 6. BẢNG PHIÊN QUÉT BẢN ĐỒ (MAPPING_SESSIONS)
CREATE TABLE IF NOT EXISTS mapping_sessions (
  id TEXT PRIMARY KEY CHECK (length(id) BETWEEN 1 AND 128),
  robot_id TEXT NOT NULL DEFAULT 'robot-01',
  active BOOLEAN NOT NULL DEFAULT true,
  name TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('starting', 'mapping', 'finishing', 'save_failed')),
  started_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  ended_at TIMESTAMPTZ,
  recovery_context JSONB
);
-- RÀNG BUỘC: Mỗi robot tại một thời điểm chỉ được phép có duy nhất 1 phiên mapping active
CREATE UNIQUE INDEX IF NOT EXISTS mapping_sessions_single_active_idx 
ON mapping_sessions (robot_id) WHERE active = true;

-- 7. BẢNG CÔNG VIỆC BẤT ĐỒNG BỘ (JOBS)
CREATE TABLE IF NOT EXISTS jobs (
  id TEXT PRIMARY KEY CHECK (length(id) BETWEEN 1 AND 128),
  kind TEXT NOT NULL CHECK (kind IN ('start_mapping', 'finish_mapping', 'activate_map', 'preview_route')),
  status TEXT NOT NULL CHECK (status IN ('accepted', 'running', 'completed', 'failed')),
  result JSONB,
  error JSONB,
  principal TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- 8. BẢNG LỘ TRÌNH WAYPOINT (ROUTES)
CREATE TABLE IF NOT EXISTS routes (
  id TEXT PRIMARY KEY CHECK (length(id) BETWEEN 1 AND 128),
  map_id TEXT NOT NULL,
  revision TEXT NOT NULL,
  name TEXT NOT NULL CHECK (length(name) BETWEEN 1 AND 128),
  poses JSONB NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  FOREIGN KEY (map_id, revision) REFERENCES map_revisions(map_id, revision) ON DELETE CASCADE
);

-- 9. BẢNG NHIỆM VỤ ĐIỀU HƯỚNG (MISSIONS)
CREATE TABLE IF NOT EXISTS missions (
  id TEXT PRIMARY KEY CHECK (length(id) BETWEEN 1 AND 128),
  robot_id TEXT NOT NULL DEFAULT 'robot-01',
  request_id TEXT NOT NULL,
  map_id TEXT NOT NULL,
  revision TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('navigate_to_pose', 'navigate_through_poses')),
  poses JSONB NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('accepted', 'executing', 'canceling', 'succeeded', 'failed', 'canceled')),
  current_pose_index INTEGER,
  distance_remaining_m DOUBLE PRECISION,
  error JSONB,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  FOREIGN KEY (map_id, revision) REFERENCES map_revisions(map_id, revision) ON DELETE RESTRICT
);
-- RÀNG BUỘC: Mỗi robot chỉ có tối đa 1 nhiệm vụ navigation đang hoạt động (chưa terminal)
CREATE UNIQUE INDEX IF NOT EXISTS missions_single_active_idx 
ON missions (robot_id) WHERE status IN ('accepted', 'executing', 'canceling');

-- 10. BẢNG SỔ CÁI IDEMPOTENCY (IDEMPOTENCY_REQUESTS)
CREATE TABLE IF NOT EXISTS idempotency_requests (
  principal_scope TEXT NOT NULL,
  request_id TEXT NOT NULL CHECK (length(request_id) BETWEEN 1 AND 128),
  operation TEXT NOT NULL,
  fingerprint TEXT NOT NULL CHECK (length(fingerprint) = 64),
  state TEXT NOT NULL CHECK (state IN ('pending', 'completed', 'failed', 'expired')),
  response_payload JSONB,
  response_status INTEGER CHECK (response_status BETWEEN 200 AND 599),
  resource_ref JSONB,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at TIMESTAMPTZ NOT NULL,
  PRIMARY KEY (principal_scope, request_id),
  CHECK (state NOT IN ('completed', 'failed') OR response_status IS NOT NULL)
);
CREATE INDEX IF NOT EXISTS idempotency_expiry_idx ON idempotency_requests (expires_at);

-- 11. BẢNG SỰ KIỆN AUDIT HỆ THỐNG (EVENTS)
CREATE TABLE IF NOT EXISTS events (
  id BIGSERIAL PRIMARY KEY,
  event_type TEXT NOT NULL,
  robot_id TEXT NOT NULL DEFAULT 'robot-01',
  principal TEXT,
  payload JSONB NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
