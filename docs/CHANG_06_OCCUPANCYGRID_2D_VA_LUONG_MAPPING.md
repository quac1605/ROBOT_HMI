# Chặng 6 — OccupancyGrid 2D và luồng mapping

[Mục lục](./README.md) · Trước: [Chặng 5](./CHANG_05_MAP_2D_CHON_DICH.md) · Tiếp: [Chặng 7](./CHANG_07_NAVIGATION_WAYPOINT.md)

Cập nhật ngày **09/09/2026**. Đây là **bài thực hành chính thức ngay sau Chặng 5**. Làm lần lượt các mục trong file này rồi kiểm tra mục 10 trước khi sang Chặng 7. File đã được đổi tên thành `CHANG_06_OCCUPANCYGRID_2D_VA_LUONG_MAPPING.md` phản ánh đúng nội dung OccupancyGrid 2D.

Bài đã chứa cấu trúc dữ liệu, fixture và hàm raster cần cho phần thực hành. HUONG_DAN_MAP.md chỉ giải thích kiến trúc để tham khảo thêm; bạn không cần chuyển sang đó để theo một trình tự khác. Nội dung mới là hướng dẫn triển khai, không phải xác nhận code đã hoàn thành.

## 1. Mục tiêu và chuẩn bị

Đầu vào là Map2D, các hàm world/grid/SVG, goalDraft và RobotClient của chặng 4–5. Đầu ra là hai page cùng dùng nền occupancy: Navigation xem map đã lưu, Mapping xem grid đang cập nhật và quản lý start/finish/save bằng job mock.

Chặng này không yêu cầu cài Three.js, Fiber, Drei, ROS hoặc database. React/MUI làm UI, Zod kiểm tra dữ liệu nhận, Zustand giữ metadata/state nhỏ. Canvas 2D, ImageData, Blob URL và SVG là API có sẵn của browser. Canvas chuyển ô lưới thành ảnh; SVG hiện tại giữ tương tác nên tránh phải viết lại pan/zoom/chọn đích. [Canvas](https://developer.mozilla.org/en-US/docs/Web/API/CanvasRenderingContext2D/putImageData)

PointCloud 3D/HPC1 là phần mở rộng riêng, không phải điều kiện qua chặng 6. Grid 2D chưa đáp ứng yêu cầu xoay/xem chiều cao PointCloud như RViz; việc đó vẫn còn nếu cần hoàn thiện yêu cầu 3D ban đầu.

Nguồn thật: LiDAR/camera/IMU → SLAM trên ROS → tầng tạo occupancy đúng ngữ nghĩa → adapter → HMI. Không cộng raw scan thành bản đồ trong React. Có map 3D chưa chứng minh stack đã có grid phù hợp Nav2.

## 2. Nắm cấu trúc dữ liệu và viết phần kiểm tra đầu vào

Phần cần dùng ở chặng này được trình bày ngay dưới đây. [Hợp đồng API](./HOP_DONG_API_HMI.md) là tài liệu tra cứu khi cần đối chiếu thêm, không phải một chặng thực hành khác.

`MapGridSnapshot` là object `{source,mode,encoding,context,gridRevision,grid}`: source='mock' trong bài, mode='snapshot', encoding='occupancy-0-100-v1'. `getMapGrid` trả object này. Subscription bọc nó trong event map.grid. Bạn mô phỏng các event bằng callback ở chặng 6, chưa mở HTTP/WebSocket.

Một `map.grid` gồm envelope, context, gridRevision và grid ROS đã chuẩn hóa:

- Saved context: `{kind:'saved',mapId,mapRevision}`.
- Live context: `{kind:'mapping',mappingSessionId}`; chưa có mapId đã lưu.
- Grid: `header.frame_id`, `info.resolution/width/height/origin`, `data`.
- Encoding `occupancy-0-100-v1`: -1 unknown, 0 free, 100 occupied, 1…99 trung gian. Không tự đoán nguồn ROS dùng 0/1 hay 0…100.
- mapRevision định danh asset bất biến; gridRevision tăng khi grid đổi; sequence là thứ tự truyền trong stream/epoch. Chúng có mục đích khác nhau.

Envelope callback map.grid có các trường `{version:1,type:'map.grid',subscriptionId,streamId,streamEpoch,sequence,sentAt,payload}`; payload là MapGridSnapshot. Các id là string không rỗng; sequence/gridRevision là số nguyên an toàn không âm; sentAt là ISO UTC. streamEpoch đổi khi nguồn được tạo lại, sequence tăng trong cùng stream/epoch; subscriptionId mới phân biệt lần đăng ký mới. mapRevision luôn là string, không lấy sequence làm revision map đã lưu.

Tạo `frontend/src/schemas/mapGrid.js`: dùng Zod cho object/metadata, vòng lặp có giới hạn để kiểm tra cells. Kiểm tra width/height nguyên dương, data.length=width*height; chặn version/encoding/context sai, frame rỗng, resolution ≤0, dimensions/cell count quá trần, số không hữu hạn, cells ngoài [-1,100] hoặc không nguyên. Timestamp ROS có sec nguyên, nanosec nguyên trong [0,1e9). Validate trước khi ép Int8Array/cấp phát RGBA.

Quaternion phải hữu hạn, gần norm 1; normalize chỉ sai số nhỏ (policy norm 1e-3). Nhánh phẳng từ chối roll/pitch vượt 1e-4 rad; không bỏ nghiêng rồi coi hợp lệ. Sau đó đổi quaternion sang yaw và xuất metadata `{frameId,width,height,resolution,origin:{x,y,yaw}}` cho các hàm chặng 5.

Tạo `frontend/src/utils/normalizeOccupancyGrid.js`. Hàm nhận snapshot hợp lệ, lấy frameId từ grid.header.frame_id, geometry từ grid.info và cells từ grid.data. Sau khi kiểm tra norm, chia các thành phần quaternion cho norm để tính:

```text
roll  = atan2(2*(w*x + y*z), 1 - 2*(x*x + y*y))
pitch = asin(clamp(2*(w*y - z*x), -1, 1))
yaw   = atan2(2*(w*z + x*y), 1 - 2*(y*y + z*z))
```

Clamp ở đây chỉ giữ đối số asin trong miền [-1,1] do sai số số thực của quaternion đã kiểm tra; không dùng để che quaternion sai. Hàm trả `{context,gridRevision,geometry,cells}`, trong đó geometry là metadata hình học ở trên, cells là Int8Array được tạo sau validation. Giữ context riêng với geometry để không nhầm hai map có cùng kích thước/frame.

Khi dữ liệu sai, trả/throw lỗi có code/message để hook xử lý; giữ snapshot tốt trước đó và cảnh báo, không thay bằng map trắng. Dùng INVALID_MAP_DATA cho dữ liệu sai, UNSUPPORTED_MAP_ORIENTATION cho nghiêng không hỗ trợ; MAP_TOO_LARGE cho vượt profile.

Trần thử: 262144 ô, mỗi chiều ≤4096, message UTF-8 ≤2 MiB, metadata ≤16 KiB. Đây là profile thử có giới hạn, không phải lời hứa hỗ trợ mọi diện tích nhà xưởng. Vượt trần trả MAP_TOO_LARGE; không cắt cells rồi giữ geometry cũ.

## 3. Tạo fixture có kết quả biết trước

Tạo `frontend/src/clients/demoOccupancyGrid.js` với **nội dung file khởi đầu** dưới đây. Fixture là dữ liệu mẫu cố định để có thể tính trước kết quả:

```js
export function createDemoGridSnapshot() {
  return {
    source: 'mock',
    mode: 'snapshot',
    encoding: 'occupancy-0-100-v1',
    context: {
      kind: 'saved',
      mapId: 'map-fixture-4x3',
      mapRevision: 'rev-1',
    },
    gridRevision: 1,
    grid: {
      header: { frame_id: 'map', stamp: { sec: 100, nanosec: 0 } },
      info: {
        map_load_time: { sec: 100, nanosec: 0 },
        resolution: 0.05,
        width: 4,
        height: 3,
        origin: {
          position: { x: 0, y: 0, z: 0 },
          orientation: { x: 0, y: 0, z: 0, w: 1 },
        },
      },
      data: [
        0, 100, -1, 50, // hàng ROS dưới cùng
        100, 0, 50, -1,
        -1, 50, 0, 100, // hàng ROS trên cùng
      ],
    },
  };
}
```

Dùng pattern cố định, không random mỗi render. Fixture 4×3 chỉ rộng 0.2×0.15 m nên dùng để test màu/thứ tự ô, không chờ thấy pose robot mặc định nằm trong đó. Gọi factory khi chuẩn bị dữ liệu hoặc khởi tạo mock, không tạo snapshot mới trong mỗi lần render.

Sau fixture nhỏ, bổ sung factory map 200×160, resolution 0.05 với pattern có cả unknown/free/occupied; một map cùng kích thước có origin (10,-3,π/2) để kiểm tra tọa độ. Quaternion của origin yaw θ là x=y=0, z=sin(θ/2), w=cos(θ/2). Mỗi map mẫu khác nội dung/geometry phải có mapId riêng hoặc mapRevision mới, không dùng lại id/revision fixture nhỏ. Map 200×160 dùng để ghép Navigation và thử các mốc mục 9. Raster và metadata phải cùng một snapshot.

Thêm scenario live: toàn unknown rồi mở dần vùng đã quan sát; hiệu chỉnh một vùng; thay origin/dimensions; ngừng nguồn; gửi frame sai. Số ô được biết không được gắn nhãn “đã khảo sát 100%” nếu chưa định nghĩa khu vực mục tiêu.

## 4. Thêm raster vào Map2D hiện tại

Tạo `frontend/src/utils/occupancyToRgba.js` với **nội dung file** dưới đây. Đầu vào width/height/cells phải qua validator ở mục 2. Hàm trả mảng màu RGBA, bốn số cho mỗi pixel:

```js
export function occupancyToRgba({ width, height, cells }) {
  const rgba = new Uint8ClampedArray(width * height * 4);
  for (let row = 0; row < height; row += 1) {
    for (let column = 0; column < width; column += 1) {
      const value = cells[column + row * width];
      const output = (column + (height - 1 - row) * width) * 4;
      const gray = Math.round(255 * (1 - value / 100));
      rgba[output] = value === -1 ? 176 : gray;
      rgba[output + 1] = value === -1 ? 190 : gray;
      rgba[output + 2] = value === -1 ? 197 : gray;
      rgba[output + 3] = 255;
    }
  }
  return rgba;
}
```

0 thành trắng, 100 thành đen, 50 thành xám 128; -1 thành xanh xám (176,190,197) để phân biệt unknown với mức trung gian. Màu không phải quyết định robot đi được. Viết test row order/palette ở mục 9 trước khi ghép UI.

Các phép đổi phải thống nhất:

- Index ROS: `column + row * width`.
- Hàng pixel: `height - 1 - row`.
- Tâm ô: `(column + 0.5, row + 0.5)`.
- Tọa độ click liên tục vẫn dùng `svgY = height - v`; không thêm 0.5 hoặc trừ 1 vào mọi click.

Tạo `components/map/OccupancyGridLayer.jsx`:

1. Nhận snapshot đã validate, tạo RGBA và canvas ngoài DOM.
2. Tạo canvas có width/height đúng số ô, lấy context 2d; dùng `new ImageData(rgba,width,height)`, gọi putImageData rồi toBlob và tạo URL bằng URL.createObjectURL. Canvas/context hoặc Blob không tạo được phải thành lỗi hiển thị.
3. Đưa ảnh vào `<image x={0} y={0} width={width} height={height}>` trong **chính SVG của Map2D**, dùng `pointerEvents="none"` và `imageRendering: 'pixelated'`.
4. Bỏ nền/vật cản minh họa viết cứng bằng rect. Giữ robot, goal, worldToSvg/svgToWorld, form bàn phím, pointer capture/cancel, ButtonGroup và các cải tiến chặng 5.
5. Không xoay riêng ảnh bằng origin yaw: hệ SVG đang là grid, worldToSvg đã tính yaw. Chỉ thay toàn bộ mô hình tọa độ nếu có yêu cầu khác.

Ảnh và metadata phải commit cùng nhau. toBlob có thể trả muộn hoặc null: gắn generation/context/gridRevision, bỏ kết quả cũ, giữ snapshot tốt có cảnh báo nếu lỗi. Revoke URL khi thay/unmount; không revoke khi ảnh hiện hành vẫn cần dùng.

Giữ tối đa một raster đang xử lý và một snapshot mới nhất chờ. Nếu map A chuyển sang B, callback A không được ghi vào B. Same geometry update chỉ thay ảnh và giữ pan/zoom; geometry đổi thì hủy pointer đang kéo và fit lại một lần. Không dùng gridRevision làm key của toàn Map2D.

## 5. Tách viewer khỏi dịch vụ mapping

Bổ sung vào RobotClient hiện tại, giữ các phương thức đã có:

```text
listMaps() → Promise<metadata[]>
getMap(mapId, revision) → Promise<metadata>
getMapGrid(context) → Promise<MapGridSnapshot>
subscribeMapGrid(context, listener) → unsubscribe
getActiveMappingSession() → Promise<{session:null|MappingSession}>
startMapping({name,requestId}) → Promise<{mappingSessionId,jobId,status:'accepted'}>
finishMapping({mappingSessionId,name,requestId}) → Promise<{jobId,status:'accepted'}>
subscribeJobs(listener) → unsubscribe
getJob(jobId) → Promise<Job>
```

getMap vẫn trả metadata; không đổi ngầm sang mảng cells. getMapGrid(context) trả MapGridSnapshot. subscribeMapGrid nhận các event cùng envelope ở mục 2:

- map.grid: payload là snapshot mới nhất.
- map.status: payload `{context,state,sourceState,lastSourceUpdateAgeMs}`. state là waiting/ready; sourceState là live/stale/offline/saved; tuổi là ms hữu hạn không âm hoặc null nếu không áp dụng/chưa biết.
- map.error: payload `{context,error:{code,message}}`.

Mock chưa có grid thì gửi waiting; lỗi async báo listener, không throw ngược về thời điểm đăng ký. Callback cũ sau unsubscribe/đổi context bị bỏ. Chỉ trả snapshot immutable/clone, listener không sửa state của service.

Job có `{jobId,status,result,error}`; status là accepted/running/completed/failed. subscribeJobs phát cùng shape getJob trả. Kết quả start có mappingSessionId; kết quả save có mapId/mapRevision. Metadata map có `id,revision,status,frameId,width,height,resolution,origin,assets,capabilities`; id/revision tương ứng mapId/mapRevision của context. Khi saved map ready, assets mô tả các asset mock đã lưu và capabilities gồm hasOccupancyGrid/hasSlamState/canResumeMapping/canLocalize/canNavigate. Ghi source mock rõ; file trong memory không phải asset robot thật.

Viewer cleanup chỉ dừng listener/render của nó. Rời MappingPage không tự dừng SLAM, xóa session hoặc gọi dispose toàn RobotClient. Logout đóng transport/thu hồi quyền; chính sách xử lý mapping/mission khi logout phải ở service và có kết quả rõ.

## 6. Viết MockMappingService và một robot state chung

Tạo `clients/mockMapping.js`, `clients/mockMapGrid.js`; tích hợp factory vào mockRobotClient. Refactor mockTelemetry để telemetry/mapping/mission sau này cùng đọc và cập nhật một robotState. Bổ sung `activeMappingSessionId` vào schema và mọi fixture state; không tạo pose riêng trong page.

State dịch vụ: activeSession, jobs, maps/map revisions, grid cache, requestIndex, listeners, timers. MappingSession có `mappingSessionId,name,status`; status là `starting|mapping|finishing|save_failed`. Khi finish thành công, session active trở về null; lịch sử/kết quả nằm trong job và map đã lưu. Đọc lại session sau refresh không tự tạo phiên mới.

Start:

1. Kiểm tra login/mode và requestId. Cùng id + cùng payload trả resource cũ; khác payload báo conflict. Chỉ một phiên active.
2. Tạo session starting và job accepted trước khi trả response; cập nhật robotState theo context mới: activeMap=null, activeMappingSessionId đúng, pose=null cho đến khi có pose xác nhận thuộc phiên mới.
3. Mock xác nhận bắt đầu: session mapping, job completed, mode mapping và activeMappingSessionId đúng.
4. Phát grid cùng session. Start-job completed nghĩa là khởi động thành công; phiên mapping vẫn hoạt động.

Finish:

1. Chỉ nhận đúng active session ở mapping/save_failed; tạo save job, chuyển finishing và khóa nút Save.
2. Lưu grid và mô phỏng các asset bắt buộc của stack; không lưu PNG browser làm dữ liệu gốc.
3. Chỉ khi đủ asset và finalize metadata thành công mới tạo mapId/mapRevision ready, job completed, xóa activeSession/activeMappingSessionId và trả mode idle. activeMap vẫn null và pose chuyển null khi không còn context live; chỉ gắn pose lại khi nguồn xác nhận thuộc map được activate sau này.
4. Save lỗi: job failed với SAVE_FAILED, session save_failed; giữ grid và dữ liệu phục hồi. Gửi lại cùng requestId chỉ đối soát job cũ; một lần thử lưu mới sau thất bại đã xác nhận dùng requestId mới.
5. Không tự activate map vừa lưu hoặc tự tạo mission.

Timer có guard cho session/job còn hiệu lực; dispose toàn mock phải hủy timer/listener. Dữ liệu mock trong memory mất khi reload toàn app là giới hạn phải hiển thị; chặng 9 backend mới giữ phiên qua browser refresh. Với chuyển route không reload, phiên phải còn nguyên.

## 7. Ghép MappingPage và NavigationPage

MappingPage:

- Form tên, Start, Finish/Save, trạng thái phiên/job, lỗi, nhãn “Mô phỏng”, chú giải unknown/free/occupied và tuổi nguồn live.
- Đăng ký job listener trước request; sau khi nhận jobId gọi getJob để không bỏ event nhanh. Dùng ref khóa double-click tức thời.
- Khi mở, getActiveMappingSession rồi subscribe đúng context. Chưa có grid hiện waiting; không giả bản đồ trắng.
- Toggle các lớp grid/robot/path chỉ là UI. Chưa có path thì không vẽ đường giả.
- Save completed chuyển context xem sang map đã lưu, làm mới danh mục; save lỗi không mất hình hiện có.

NavigationPage:

- Thay hai map mẫu độc lập bằng listMaps/getMap/getMapGrid hoặc subscription.
- Giữ goalDraft và phép đổi mét/radian. Đổi mapId/mapRevision clear draft/preview, fit map mới.
- Robot chỉ hiện khi frame và activeMap id/revision trùng; live Mapping dùng activeMappingSessionId. Thiếu context thì không ghép pose.
- Map đang xem khác map đang active là hai trạng thái riêng. Chặng 6 chỉ demo xem/chọn đích, nút Submit chưa chạy mission. Chặng 7 mới nối Submit với mission và điều kiện trạng thái mô phỏng trong MockRobotClient; backend thật thuộc chặng 9.
- Occupancy dùng cảnh báo đầu vào; ô free không chứng minh footprint đi được. Chưa có planner thì không khẳng định đường tránh vật cản.

Tạo `hooks/useMapGrid.js` để quản lý subscription/generation/error. Ở chặng 6, dùng getMapGrid và callback mock; nếu snapshot được hỏi trước về muộn hơn event mới trong cùng generation thì bỏ response cũ. Chặng 9 áp dụng cùng nguyên tắc khi thay bằng HTTP/WS; bạn chưa cần mở socket ở bài này.

Saved grid cùng revision vẫn hợp lệ dù không đổi sau hai giây; tuổi pose được kiểm tra riêng. Với live mapping, mock theo dõi thời gian nguồn thực sự cập nhật bằng performance.now(), phát tuổi nguồn qua map.status; gửi lại cache/status không làm nguồn cũ thành mới. Chọn ngưỡng stale cho scenario mock có ghi nhãn, không dùng nó làm thông số vận hành robot.

## 8. Tham khảo cho chặng 9–10 — có thể bỏ qua khi đang làm chặng 6

Phía Ubuntu cần `nav_msgs/msg/OccupancyGrid`, pose/TF và path phù hợp. API GetMap/LoadMap/SaveMap ở map server/saver chỉ dùng nếu stack cung cấp; SaveMap lưu grid, không lưu state SLAM. Start/finish SLAM phụ thuộc implementation, không có API RViz chung. [Nav2 Map Server](https://github.com/ros-navigation/navigation2/blob/jazzy/nav2_map_server/README.md)

Nếu chỉ có cloud sau SLAM, nhóm ROS phải làm exporter có chính sách ground/height/free/unknown và xử lý hiệu chỉnh lịch sử. OctoMap là ứng viên có điều kiện, không feed cloud tích lũy frame map như một scan có sensor origin tại gốc map.

HMI test được yaw origin bất kỳ không đồng nghĩa Nav2 nạp được trực tiếp. Với StaticLayer Jazzy được đối chiếu, dùng grid axis-aligned hoặc resample đúng ở ROS; không chỉ đặt quaternion về 0. [Phân tích kiến trúc tham khảo](./HUONG_DAN_MAP.md) giải thích thêm; phần tích hợp được thực hiện theo chặng 10.

Chặng 9 thêm `/map-stream` có auth/session/Origin và Node mock; chặng 10 nối adapter ROS, QoS và cache cho viewer đến sau. Không dùng HPC1 để đóng occupancy. HPC1 giữ nguyên cho [viewer 3D tùy chọn](./GIAO_THUC_POINTCLOUD.md).

## 9. Kiểm tra toán học, lifecycle và tải

1. Fixture 4×3: hàng trên ảnh là unknown, xám 128, trắng, đen; hàng dưới đúng 0/100/-1/50.
2. Map 200×160, resolution .05: world (1,2) → grid (20,40) → SVG (20,120).
3. Origin (10,-3,π/2): grid (20,40) → world (8,-2). Không double-rotate, robot/goal trùng raster.
4. Pan/zoom/resize/nhập số giữ tọa độ; giữ các test biên của chặng 5. Floor chỉ sau kiểm tra bounds; xử lý sai số biên dưới theo policy, không clamp điểm ngoài map.
5. Grid sai size/count/value/quaternion bị từ chối trước cấp phát; giữ hình tốt và không cập nhật timestamp nhận tốt.
6. Đổi A→B khi raster A chưa xong; geometry thay giữa pointerDown/Up; unmount khi toBlob pending đều không làm sai hình hoặc rò URL.
7. Double-start, save failed/retry, đổi trang, getJob ngay sau accepted, map vừa lưu xuất hiện đúng revision.
8. Saved map im lặng vẫn hợp lệ; live nguồn dừng phải báo trạng thái nguồn. Heartbeat không làm mới tuổi grid/pose.
9. Thử 200×160 rồi 512×512 ở 1/2 Hz. Đo UTF-8 byte/message và byte/s, validate/raster time, heap, render responsiveness, số snapshot bỏ và chiều dài queue; không dùng số byte Int8Array làm lưu lượng JSON.
10. Chặng 9 bổ sung hai viewer + video test và event-loop delay Node; chặng 10 lặp trên robot/LAN. Chỉ tăng ngân sách sau khi đo.

Trong frontend, chạy các test hàm thuần (bao gồm test mới của bạn) và kiểm tra lint/build:

```powershell
node --test
npm.cmd run lint
npm.cmd run build
```

Browser test vẫn cần cho Canvas/toBlob/pointer; Node test không chứng minh các tương tác đó đã chạy đúng.

## 10. Tiêu chí hoàn thành

- [ ] Navigation và Mapping dùng được nền occupancy từ cùng contract, palette và tọa độ đúng.
- [ ] Metadata/ảnh/pose/path không lẫn context; raster mới không reset viewport nếu geometry không đổi.
- [ ] Có một robotState chung, start/job/finish/save failure/idempotency đúng.
- [ ] Rời page không dừng phiên; mock reload có giới hạn được ghi rõ; backend refresh recovery dành cho chặng 9.
- [ ] Saved map có revision/assets/capabilities mô phỏng rõ; save thất bại không tạo ready, load lại được từ danh mục.
- [ ] Payload sai, async race, cleanup và queue đã kiểm tra; có số đo theo profile thử.
- [ ] Test toán học/raster/schema, lint/build và browser case phù hợp đạt.

Sang [chặng 7](./CHANG_07_NAVIGATION_WAYPOINT.md) khi các tiêu chí trên đạt. Bạn tiếp tục theo số chặng; không có bài thực hành bắt buộc nằm giữa chặng 6 và chặng 7. Khi báo hoàn thành, ghi phần đã làm, kiểm tra đã chạy và lỗi còn lại; các file trạng thái/nhật ký chỉ giúp lưu mốc đó.

