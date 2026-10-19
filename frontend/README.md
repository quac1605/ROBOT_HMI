# React + Vite

## Chạy mock trên nhánh combine

Nhánh `combine` giữ hai trang trên menu ngang:

- `/mapping`: tạo bản đồ, camera trước/sau và joystick từ TeleopPage.
- `/navigation`: điều hướng, ô trạng thái robot từ StatusPage và khung Camera quan sát. Trạng thái phát hiện người & cử chỉ nằm trong khung camera, chỉ áp dụng cho cam trước. Phần nhận diện thực tế chưa nối backend/model.

Các đường dẫn cũ `/teleop` chuyển tới `/mapping`; `/status` và `/gesture` chuyển tới `/navigation`.
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

## Kiểm tra mã nguồn và build

Chạy từ `frontend`; khi build mock, đặt `VITE_ROBOT_CLIENT=mock` như hướng dẫn ở trên.

```bash
npm run lint -- --max-warnings=0
npm run build
```

Các bộ test, cấu hình Playwright và scripts test/benchmark/evidence/verify đã được gỡ khỏi ứng dụng. Nội dung trong `docs/`, bao gồm test và báo cáo lịch sử, được giữ nguyên để tham khảo.

## Môi trường Ubuntu

Từ repository root, `.nvmrc` pin Node 22.23.3. Cài dependencies trên Ubuntu, không chép `node_modules` Windows. Bàn giao riêng video/manifest trong `docs/public/demo/` vì chúng không được Git quản lý.

```bash
nvm install
nvm use
npm ci --prefix packages/contracts
npm ci --prefix packages/control-domain
npm ci --prefix frontend --include=dev
cd frontend
VITE_ROBOT_CLIENT=mock npm run dev
```

This template provides a minimal setup to get React working in Vite with HMR and some ESLint rules.

Currently, two official plugins are available:

- [@vitejs/plugin-react](https://github.com/vitejs/vite-plugin-react/blob/main/packages/plugin-react) uses [Oxc](https://oxc.rs)
- [@vitejs/plugin-react-swc](https://github.com/vitejs/vite-plugin-react/blob/main/packages/plugin-react-swc) uses [SWC](https://swc.rs/)

## React Compiler

The React Compiler is not enabled on this template because of its impact on dev & build performances. To add it, see [this documentation](https://react.dev/learn/react-compiler/installation).

## Expanding the ESLint configuration

If you are developing a production application, we recommend using TypeScript with type-aware lint rules enabled. Check out the [TS template](https://github.com/vitejs/vite/tree/main/packages/create-vite/template-react-ts) for information on how to integrate TypeScript and [`typescript-eslint`](https://typescript-eslint.io) in your project.
