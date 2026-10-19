import { Navigate, Route, Routes } from 'react-router';
import AppShell from './components/layout/AppShell.jsx';
import RobotOperationCoordinator from './components/RobotOperationCoordinator.jsx';
import ControlOperationCoordinator from './components/ControlOperationCoordinator.jsx';
import RequireAuth from './auth/RequireAuth.jsx';
import LoginPage from './pages/LoginPage.jsx';
import MappingPage from './pages/MappingPage.jsx';
import NavigationPage from './pages/NavigationPage.jsx';

export default function App() {
  return (
    <Routes>
      {/* Route Login công khai, không cần bảo vệ */}
      <Route path="/login" element={<LoginPage />} />

      {/* Nhóm các route yêu cầu đăng nhập */}
      <Route element={<RequireAuth />}>
        <Route
          element={
            <RobotOperationCoordinator>
              <ControlOperationCoordinator>
                <AppShell />
              </ControlOperationCoordinator>
            </RobotOperationCoordinator>
          }
        >
          <Route index element={<Navigate to="/navigation" replace />} />
          {/* StatusPage đã gộp vào NavigationPage (cửa sổ trạng thái nổi); giữ /status để link cũ không gãy */}
          <Route path="/status" element={<Navigate to="/navigation" replace />} />
          <Route path="/mapping" element={<MappingPage />} />
          <Route path="/navigation" element={<NavigationPage />} />
          {/* Trang cử chỉ đã gộp vào khung camera của /navigation; giữ /gesture để link cũ không gãy */}
          <Route path="/gesture" element={<Navigate to="/navigation" replace />} />
          <Route path="/teleop" element={<Navigate to="/mapping" replace />} />
        </Route>
      </Route>

      {/* Bất kỳ route lạ nào cũng chuyển về /navigation */}
      <Route path="*" element={<Navigate to="/navigation" replace />} />
    </Routes>
  );
}
