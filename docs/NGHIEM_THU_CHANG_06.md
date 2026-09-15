# BÁO CÁO NGHIỆM THU CHẶNG 6

## OccupancyGrid 2D và luồng SLAM Mapping

- Ngày nghiệm thu: 2026-09-15
- Tài liệu căn cứ: `docs/CHANG_06_OCCUPANCYGRID_2D_VA_LUONG_MAPPING.md`, đặc biệt Mục 9 và Mục 10
- Môi trường: Windows 11 (`Windows_NT 10.0.26200 x64`), Node.js `v22.21.0`, Vite `v8.2.2`, Chromium `152.0.7977.83`
- Kết luận: **ĐẠT — READY FOR STAGE 7**

Kết luận này chỉ áp dụng cho phạm vi Chặng 6. Mục 9.10 được ghi nhận là `DEFERRED_STAGE_9_10` đúng theo tài liệu; đây không phải một false-pass của Chặng 6.

## 1. Các cổng kiểm tra đã chạy

Chạy từ thư mục `frontend` trừ `git diff --check` chạy ở thư mục gốc repository:

```powershell
node --test
npm.cmd run test:browser
npm.cmd run lint -- --max-warnings=0
npm.cmd run build
npm.cmd run benchmark:grid
npm.cmd run benchmark:grid:check
npm.cmd run evidence:check
git diff --check
```

Kết quả:

- Node test: **97/97 passed**, 0 failed, 0 skipped, 0 cancelled, 0 todo.
- Browser acceptance: **15/15 passed**, 0 unexpected, 0 skipped, 0 flaky; không có Playwright global error. Các case có guard đối với `console.error`, `pageerror` và unhandled rejection.
- ESLint: **0 error, 0 warning** với `--max-warnings=0`.
- Production build: **PASS**. Bundle production không chứa `__STAGE6_TEST_CONTROLS__`; test controls chỉ tồn tại khi vừa ở DEV mode vừa bật biến môi trường chuyên dụng.
- Benchmark checker: **PASS** trên bốn profile bắt buộc và tái tính kết quả từ raw samples cùng raw responsiveness/rAF/long-task series thay vì tin vào summary có sẵn.
- Evidence checker: **PASS**; tự chạy đúng lệnh `node --test` và chặn trường hợp 0 test, đồng thời xác nhận artifact browser/benchmark tồn tại, đủ case, không stale so với toàn bộ application source hoặc production pipeline/checker/budget và không có test bị skip/xfail.
- `git diff --check`: **PASS**, không có whitespace error.

Artifact máy đọc được:

- `frontend/artifacts/stage6/browser-results.json`
- `frontend/artifacts/stage6/benchmark-results.json`
- `frontend/artifacts/stage6/quality-budgets.json`

## 2. Đối chiếu Mục 9

1. **Fixture 4×3, palette và row flip — ĐẠT.** Unit test kiểm tra exact RGBA cho `-1`, `0`, `50`, `100`; browser Case 1 kiểm tra blob tạo từ production raster pipeline.
2. **Map 200×160, resolution 0.05 — ĐẠT.** Test tọa độ kiểm tra world `(1,2)` → grid `(20,40)` → SVG `(20,120)`.
3. **Origin quay π/2, không double-rotate — ĐẠT.** Unit/browser test dùng chung transform cho raster, robot và goal.
4. **Pan/zoom/resize/nhập số/bounds — ĐẠT.** Browser Case 3 và 6 kiểm tra bảo toàn world goal, viewBox, policy biên, giữ viewport khi geometry không đổi và hủy pointer transaction khi geometry đổi.
5. **Validation trước cấp phát, giữ last-good — ĐẠT.** Schema/gate từ chối sai size/count/value/quaternion/frame/context trước khi commit; lỗi không làm tiến cursor hoặc làm mất snapshot tốt. Late initial-fetch error và duplicate snapshot recovery đều có regression test.
6. **Async race và cleanup — ĐẠT.** Các tình huống A→B→C, context switch trong lúc decode, geometry đổi giữa pointer down/up và unmount khi `toBlob` còn pending không publish dữ liệu cũ, không vượt một active + một latest pending và không rò Blob URL.
7. **Luồng mapping/job/save — ĐẠT.** Double-start chỉ tạo một session; trạng thái `accepted` đọc được ngay; route change giữ session; finish nền cập nhật catalog đúng revision; save failure giữ raster/session để retry và không tạo map `ready` giả.
8. **Freshness — ĐẠT.** Saved map im lặng vẫn hợp lệ; live source phân biệt online/stale/offline/recovery; heartbeat hoặc đổi scenario label không làm mới giả timestamp grid/pose.
9. **Tải 200×160 và 512×512 tại 1/2 Hz — ĐẠT.** Benchmark chạy trong Chromium với production schema, normalize, raster controller/runtime và `Map2D`. Lưu lượng dùng số byte UTF-8 của toàn bộ `map.grid` envelope, không dùng riêng kích thước `Int8Array`.
10. **Hai viewer + video + Node event-loop delay/robot LAN — HOÃN ĐÚNG PHẠM VI.** `DEFERRED_STAGE_9_10`: hai viewer, video stream và Node event-loop delay thuộc Chặng 9; phép thử robot/LAN thuộc Chặng 10.

## 3. Kết quả benchmark Chromium

| Profile | Mẫu | Hz đạt | UTF-8 byte/msg | byte/s | Validate p95 | Raster p95 | `toBlob` p95 | Decode p95 | E2E p95 | Responsive p95 | rAF p95 | Long task max | Drop |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| 200×160 @ 1 Hz | 30 | 1.00 | 80,612 | 80,615 | 5.7 ms | 12.3 ms | 10.7 ms | 1.3 ms | 18.6 ms | 1.3 ms | 17.0 ms | 0 ms | 0 |
| 200×160 @ 2 Hz | 60 | 2.00 | 80,613 | 161,228 | 7.5 ms | 8.7 ms | 6.8 ms | 1.0 ms | 16.7 ms | 7.2 ms | 17.0 ms | 0 ms | 0 |
| 512×512 @ 1 Hz | 30 | 1.00 | 656,006 | 656,002 | 50.0 ms | 22.7 ms | 19.6 ms | 1.8 ms | 85.3 ms | 1.4 ms | 17.1 ms | 78 ms | 0 |
| 512×512 @ 2 Hz | 60 | 2.00 | 655,929 | 1,311,855 | 56.4 ms | 23.4 ms | 20.6 ms | 1.3 ms | 88.1 ms | 49.7 ms | 17.1 ms | 76 ms | 0 |

Các invariant chung đều đạt:

- `maxActiveTasks = 1`; `maxPendingQueue = 0` (budget cho phép tối đa 1 pending mới nhất).
- 180 Blob URL được tạo và đủ 180 URL được revoke; outstanding sau dispose bằng 0.
- 0 lỗi, 0 unhandled rejection, 0 snapshot bị drop trong lần đo này.
- Long task xuất hiện ở profile lớn nhưng giá trị lớn nhất 78/76 ms, thấp hơn budget 300 ms; responsiveness p95 lớn nhất 49.7 ms, thấp hơn budget 80 ms.
- Heap growth và heap peak growth đều nằm trong budget của từng profile.

## 4. Đối chiếu Mục 10 — 7/7 tiêu chí đạt

- [x] Navigation và Mapping dùng cùng occupancy contract, palette và hệ tọa độ.
- [x] Metadata/ảnh/pose/path được khóa theo context; raster revision mới không reset viewport khi geometry không đổi.
- [x] Chỉ có một shared robot state; start/job/finish/save failure/idempotency vận hành đúng.
- [x] Chuyển route không dừng phiên mapping; giao diện nối lại được session còn sống.
- [x] Saved map có revision/assets/capabilities rõ; save failure không tạo `ready`; map vừa lưu tải lại được từ catalog đúng revision.
- [x] Payload sai, race, lifecycle cleanup, URL ownership và queue đều có kiểm thử; bốn profile tải có số đo máy đọc được.
- [x] Test toán học/raster/schema, lint, build và browser acceptance đều đạt.

## 5. Giới hạn đã biết và quyết định chuyển chặng

- **Mock in-memory** mất session khi full browser reload/F5. Ứng dụng ghi rõ giới hạn này và Browser Case 15 khóa hành vi; persistence/recovery qua backend được dành cho Chặng 9 theo chính tài liệu Chặng 6.
- Build có cảnh báo kích thước chunk khoảng 674 kB; đây là cảnh báo tối ưu bundle, không phải lỗi build hay tiêu chí chặn của Mục 9–10.
- Không còn blocker chức năng, runtime, race hoặc resource leak nào đã biết trong phạm vi Chặng 6.

**Quyết định cuối cùng: Chặng 6 đủ điều kiện chuyển sang Chặng 7.**
