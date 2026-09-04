import { Navigate, Route, Routes } from 'react-router';
import AppShell from './components/layout/AppShell.jsx';
import LoginPage from './pages/LoginPage.jsx';
import StatusPage from './pages/StatusPage.jsx';
import MappingPage from './pages/MappingPage.jsx';
import NavigationPage from './pages/NavigationPage.jsx';
import TeleopPage from './pages/TeleopPage.jsx';

export default function App() {
  return (
    <Routes>
      {/* Route Login không dùng AppShell */}
      <Route path="/login" element={<LoginPage />} />

      {/* Các route chức năng dùng chung AppShell */}
      <Route element={<AppShell />}>
        <Route index element={<Navigate to="/status" replace />} />
        <Route path="/status" element={<StatusPage />} />
        <Route path="/mapping" element={<MappingPage />} />
        <Route path="/navigation" element={<NavigationPage />} />
        <Route path="/teleop" element={<TeleopPage />} />
      </Route>

      {/* Trang không tồn tại thì tự chuyển về /status */}
      <Route path="*" element={<Navigate to="/status" replace />} />
    </Routes>
  );
}
