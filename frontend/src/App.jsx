import { Navigate, Route, Routes } from 'react-router';
import AppShell from './components/layout/AppShell.jsx';
import RobotOperationCoordinator from './components/RobotOperationCoordinator.jsx';
import ControlOperationCoordinator from './components/ControlOperationCoordinator.jsx';
import RequireAuth from './auth/RequireAuth.jsx';
import LoginPage from './pages/LoginPage.jsx';
import StatusPage from './pages/StatusPage.jsx';
import MappingPage from './pages/MappingPage.jsx';
import NavigationPage from './pages/NavigationPage.jsx';
import TeleopPage from './pages/TeleopPage.jsx';

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
          <Route index element={<Navigate to="/status" replace />} />
          <Route path="/status" element={<StatusPage />} />
          <Route path="/mapping" element={<MappingPage />} />
          <Route path="/navigation" element={<NavigationPage />} />
          <Route path="/teleop" element={<TeleopPage />} />
        </Route>
      </Route>

      {/* Bất kỳ route lạ nào cũng chuyển về /status */}
      <Route path="*" element={<Navigate to="/status" replace />} />
    </Routes>
  );
}
