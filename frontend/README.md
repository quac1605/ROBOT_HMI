# React + Vite

## Chạy mock trên nhánh combine

Nhánh `combine` giữ ba trang trên menu ngang:

- `/mapping`: tạo bản đồ, camera trước/sau và joystick từ TeleopPage.
- `/navigation`: điều hướng và ô trạng thái robot từ StatusPage.
- `/gesture`: camera trước và giao diện trạng thái nhận diện. Phần nhận diện thực tế chưa nối backend/model.

Các đường dẫn cũ `/teleop` và `/status` lần lượt chuyển tới `/mapping` và `/navigation`.
Đăng nhập mock bằng `admin` / `demo-only`.

Từ thư mục gốc repository, cài dependencies của các package dùng chung và frontend:

```powershell
npm.cmd ci --prefix packages/contracts
npm.cmd ci --prefix packages/control-domain
npm.cmd ci --prefix frontend --include=dev
cd frontend
$env:VITE_ROBOT_CLIENT = 'mock'
npm.cmd run dev
```

Trên Ubuntu dùng `npm` thay `npm.cmd`; sau khi cài dependencies, chạy từ `frontend`:

```bash
VITE_ROBOT_CLIENT=mock npm run dev
```

Camera cần hai video trong `docs/public/demo/`; xem cách tạo ở phần tiếp theo.
Joystick chỉ được mở sau khi bắt đầu phiên mapping và nhận quyền điều khiển.

### Kiểm chứng tích hợp trên Windows (12/10/2026)

- Build mock và lint đạt; 237/237 Node tests đạt với `--test-concurrency=1`.
- Bốn browser tests trong `docs/test/browser/combine.spec.js` đạt: ba tab tích hợp, camera, đăng nhập và redirect các đường dẫn cũ.
- Hai browser tests điều khiển kế thừa `C8-03` và `C8-04` vẫn timeout khi chờ lệnh chuyển động trong lần kiểm tra lại. Bộ browser tests chưa đạt toàn bộ; logic cấp quyền lái và watchdog được giữ nguyên.

## Camera demo assets (Chặng 8)

Hai video mẫu được lưu tại **`../docs/public/demo/`**, không ở `frontend/public/demo/`.
Trước dev/build trên máy mới, bàn giao thư mục này hoặc cài FFmpeg có `libx264` và chạy từ `frontend`:

```bash
npm run assets:demo
npm run dev
```

Nếu FFmpeg không trong PATH, đặt `FFMPEG_PATH` tới executable. Script không ghi đè assets đã có.
Trên Windows có thể dùng `npm.cmd` thay `npm`. Các file trong `docs/public/` vẫn bị ignore theo chính sách tài liệu nội bộ hiện hữu; chỉ clone Git không tự mang theo video. Hướng dẫn nguồn/tái tạo/hash nằm trong `docs/public/demo/README.md` và `manifest.json` ở repository root.

Plugin `tooling/demoAssetsPlugin.mjs` giữ URL `/demo/front.mp4` và `/demo/rear.mp4`, hỗ trợ byte ranges khi dev và đóng gói vào `dist/demo/` khi build. Không đổi `publicDir` sang toàn bộ `docs`; các logo/icon hiện hữu vẫn hoạt động.

Các lệnh kiểm tra:

Node tests có kiểm tra module dùng chung với backend; cài `npm ci --prefix backend`
từ repository root trước lần chạy đầu. Khi kiểm tra mock, đặt `VITE_ROBOT_CLIENT=mock`
như hướng dẫn ở trên.

```bash
npm run lint -- --max-warnings=0
npm run build
npm run test:node
npm run test:browser
npm run verify:stage8
```

Browser runner tự khởi động/dừng server kiểm thử riêng tại cổng 4173; không cần giữ `npm run dev` để chạy test. Dev server để xem thủ công thường ở cổng 5173. `verify:stage8` là gate **toàn bộ** manifest N8/C8/U8/T8 và hồi quy Chặng 6–7, không chỉ 5 bài core mẫu của bước F. Nó phải báo FAIL khi thiếu bài test/bằng chứng Ubuntu; đây không phải lý do nới gate hoặc tạo artifact passed giả.

## Baseline Ubuntu 24.04 trước Chặng 9

Từ repository root, `.nvmrc` pin Node 22.23.3 cho lần bàn giao này. Cài dependencies/browser trên Ubuntu, không chép `node_modules` Windows. Bàn giao riêng video/manifest và hai independent probes trong `docs/chang-08-independent-review-round2` vì chúng không được Git quản lý.

```bash
nvm install
nvm use
npm ci --prefix frontend --include=dev
cd frontend
npx --no-install playwright install --with-deps chromium
cd ..
node docs/test/scripts/ubuntu_environment.mjs
node docs/test/scripts/verify_ubuntu_baseline.mjs
```

Runner đặt client mock, dùng bundled Chromium, chạy toàn bộ `verify:stage8` và probes 18/6, kiểm report mới và hashes đầu vào không đổi trong lượt chạy. Evidence nằm ở `docs/chang-09-evidence/ubuntu-baseline/<run-id>/`. Chỉ đóng M0 khi runner exit 0; không biến kết quả Windows thành nghiệm thu Ubuntu và luôn giữ `hardwareReady=false`. Hai helper đã có trong source, không cần chép code từ tài liệu để tạo lại.

This template provides a minimal setup to get React working in Vite with HMR and some ESLint rules.

Currently, two official plugins are available:

- [@vitejs/plugin-react](https://github.com/vitejs/vite-plugin-react/blob/main/packages/plugin-react) uses [Oxc](https://oxc.rs)
- [@vitejs/plugin-react-swc](https://github.com/vitejs/vite-plugin-react/blob/main/packages/plugin-react-swc) uses [SWC](https://swc.rs/)

## React Compiler

The React Compiler is not enabled on this template because of its impact on dev & build performances. To add it, see [this documentation](https://react.dev/learn/react-compiler/installation).

## Expanding the ESLint configuration

If you are developing a production application, we recommend using TypeScript with type-aware lint rules enabled. Check out the [TS template](https://github.com/vitejs/vite/tree/main/packages/create-vite/template-react-ts) for information on how to integrate TypeScript and [`typescript-eslint`](https://typescript-eslint.io) in your project.
