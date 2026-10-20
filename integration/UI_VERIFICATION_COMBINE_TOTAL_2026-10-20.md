# Xác minh UI `codex/combine-total` — 2026-10-20

## Phạm vi

- HEAD lúc bắt đầu: `ce5a315` trên branch `codex/combine-total`.
- Đối chiếu bố cục Navigation/Mapping theo hai mockup người dùng cung cấp. Giữ luồng camera WHEP và các chốt an toàn lease/stop.
- Chỉ chạy frontend ở chế độ `VITE_ROBOT_CLIENT=mock` trên `127.0.0.1:4173` cho bài browser; không khởi động lại ROS2, MediaMTX, backend hoặc camera đang phục vụ người dùng.

## Kết quả theo yêu cầu

| Hạng mục | Kết quả trong mock UI | Giới hạn xác minh |
| --- | --- | --- |
| Navigation: camera trước/sau, rail cử chỉ bên phải | Đạt; rail hiển thị `Chưa nhận diện`, đổi camera tạo reader mới và dọn reader cũ | Rail chưa có nguồn nhận diện người thật |
| Navigation: manual bật/tắt, joystick 0,3 m/s và 0,3 rad/s dưới map | Đạt; bật không tự chạy, nhả/tắt/rời trang/đổi camera dừng và trả lease | Lease `manual` bị chặn khi Mapping hoặc mission đang giữ robot; đây là guard hiện hành |
| Mapping: map trái, camera phải, tên map và Start/Stop để lưu | Đạt; không có joystick trong Mapping kể cả lúc phiên active | Việc dừng/lưu chờ xác nhận, không tự báo thành công chỉ vì đã nhấn nút |
| Camera xuyên suốt đổi map và vòng đời Mapping | Đạt trong giả lập WHEP: video và stream giữ identity, `presentedFrames` tiếp tục tăng | Không thay thế thử nghiệm hai camera ROS2 thật trên LAN |
| Route `/gesture`, `/teleop` và thanh menu | Cùng chuyển về Navigation; menu chỉ có Navigation/Mapping | Gesture chỉ là placeholder UI |

## Sửa trong lượt này và lý do

1. `frontend/src/state/mappingWorkflowStore.js`: response Finish đúng `requestId` vẫn được tiếp nhận khi coordinator tạm đặt `ready=false` để đối soát. Lưu `mappingSessionId` trong tracked operation; snapshot REST của **chính phiên vừa lưu xong** không được hồi sinh phiên đó. Phiên mới với ID khác vẫn được nhận.
2. `frontend/src/pages/MappingPage.jsx`: chuyển ID phiên vào tracker để fence response/snapshot chính xác khi người dùng rời route hoặc REST trả về muộn.
3. `frontend/src/utils/navigationCoordinator.js`: áp dụng snapshot active session trước khi đối soát job; job terminal mới hơn phải thắng snapshot cũ.
4. `frontend/src/components/control/NavigationControlPanel.jsx`: nhãn UI lấy mẫu 250 ms/lần để giảm render MUI; vòng phát velocity, đo freshness và các ngưỡng an toàn vẫn đọc store mới nhất theo cơ chế cũ. Hiện lý do khóa joystick cả khi công tắc manual còn bật.
5. `frontend/src/utils/teleopKeyboard.js`: phím Space/mũi tên trong MUI map selector, nút và tab thuộc về widget đang focus, không bị diễn giải thành lệnh lái/dừng. Khi focus joystick hoặc trang, phím lái vẫn hoạt động.
6. Bổ sung assertions trong `docs/test/browser/combineTotalWhep.spec.js`, `docs/test/browser/combineTotalControl.spec.js`, `docs/test/state/mappingWorkflowStore.test.js`, `docs/test/stage7/workflow.test.mjs`. Xóa `docs/test/browser/uiDiagnostic.spec.js` vì đây là script log điều tra tạm, không có assertion nghiệm thu.

Không sửa `CameraPanel.jsx`, `whepReader.js`, `cameraStreamClient.js`, backend camera authorization, gateway ROS hay MediaMTX. Không thay watchdog, lease TTL, ngưỡng freshness hoặc logic xác nhận dừng.

## Kiểm thử

| Bài | Kết quả |
| --- | --- |
| `npm run lint` trong `frontend/` | PASS |
| `npm run build` trong `frontend/` | PASS; Vite còn cảnh báo bundle lớn hơn 500 kB, không phải lỗi build |
| `node --test docs/test/state/mappingWorkflowStore.test.js docs/test/stage7/workflow.test.mjs` | PASS 2/2 test files, gồm hai ca race mới |
| Playwright `cameraWhepLifecycle`, `combineTotalWhep`, `mappingFinishRoute`, `navigationCamera` | PASS 5/5 trên Chromium, mock production runtime |
| Playwright `combineTotalControl` và 6 ca Stage 8 về Space, route, camera, toggle, late lease, Mapping guard | PASS 7/7 trên Chromium, mock production runtime |
| Chạy lại `combineTotalControl` sau khi thêm assertion focus MUI map selector + Space | PASS 1/1; không phát stop sai khi đang chọn map |
| Smoke build production bằng Chromium: joystick 0,3 m/s; save map; đổi camera; map selector khi manual bật | PASS trong mock; frame camera và DOM video không bị thay ngoài lúc chủ động đổi camera |

Các bài browser dùng Vite với `NODE_ENV=production`, `VITE_ROBOT_CLIENT=mock`, `VITE_ENABLE_STAGE6_TEST_CONTROLS=true`, `HTTPS=false`. Trước đó khi chạy React development runtime trên cùng máy, render MUI có lúc làm timer mock trễ hơn ngưỡng stationary/freshness 200 ms và tạo `ROBOT_NOT_STATIONARY`. Không nới ngưỡng, tăng retry hay bỏ assertion để che hiện tượng này. Cần tiếp tục đo trên thiết bị đích và nguồn ROS thật.

## Còn phải xác minh trước khi nhận vận hành robot thật

- Mở bản build trên máy LAN, kiểm tra cả `/image_front` và `/image_rear` qua MediaMTX/WHEP: phát frame liên tục khi chuyển camera, đổi map và Start/Stop Mapping; kiểm tra dọn reader khi rời route.
- ROS bridge hiện có thể cung cấp pose trong frame `odom`, trong khi viewer map cần `map`; cần nguồn pose/TF tương thích trước khi chấp nhận marker trên bản đồ thật.
- Mock motion sample chứng minh logic stop, chưa chứng minh bánh xe robot thật đã dừng. `hardwareReady=false` và guard fail-closed phải giữ cho đến khi có nguồn đo vận tốc thực và nghiệm thu phần cứng.
- Theo layout hiện tại, Navigation giữ lease `manual` còn phiên Mapping giữ authority riêng. Vì vậy không thể dùng manual để lái trong lúc Mapping active. Nếu mục tiêu sản phẩm vẫn là lái khi dựng map, cần thiết kế/duyệt luồng authority an toàn cho phiên Mapping trong một bước riêng.

Các sửa đổi là diff chưa commit. Có thể xem từng phần bằng `git diff -- <đường-dẫn-file>` trước khi chọn giữ hoặc hoàn tác; không động vào evidence M0.
