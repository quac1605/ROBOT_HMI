import {
  Alert,
  Box,
  Button,
  Chip,
  Stack,
  Tab,
  Tabs,
  Typography,
} from '@mui/material';
import { NavLink, Outlet, useLocation, useNavigate } from 'react-router';
import { useState } from 'react';
import { useAuth } from '../../auth/AuthContext.js';
import { useRobotStore } from '../../stores/robotStore.js';
import { useRobotFreshness } from '../../hooks/useRobotFreshness.js';

// Các tab chức năng hiển thị thành hàng ngang ngay dưới header
const navItems = [
  ['/navigation', 'Đi đến đích & trạng thái'],
  ['/mapping', 'Tạo bản đồ & điều khiển'],
  ['/gesture', 'Phát hiện Người & Cử chỉ'],
];

export default function AppShell() {
  const [logoutBusy, setLogoutBusy] = useState(false);
  const [logoutError, setLogoutError] = useState('');
  const { user, signOut } = useAuth();
  const navigate = useNavigate();
  const { pathname } = useLocation();
  // Tab đang chọn theo URL hiện tại; false khi không khớp tab nào (MUI không tô tab nào)
  const activeTab = navItems.some(([to]) => to === pathname) ? pathname : false;

  // Đọc trạng thái từ store và độ tươi telemetry
  const hasSnapshot = useRobotStore((state) => state.snapshot !== null);
  const rosConnected = useRobotStore((state) => state.snapshot?.rosConnected);
  const locStatus = useRobotStore((state) => state.snapshot?.localization?.status);
  const { stale } = useRobotFreshness(2000);

  async function handleLogout() {
    setLogoutBusy(true);
    setLogoutError('');
    try {
      await signOut();
      navigate('/login', { replace: true });
    } catch (cause) {
      setLogoutError(cause.message);
    } finally {
      setLogoutBusy(false);
    }
  }

  return (
    <Box sx={{ minHeight: '100dvh' }}>
      {/* Header chung */}
      <Box
        component="header"
        sx={{
          p: { xs: 2, md: 2.5 },
          bgcolor: 'background.paper',
        }}
      >
        <Stack
          direction="row"
          spacing={2}
          sx={{ justifyContent: 'space-between', alignItems: 'center' }}
        >
          {/* Bên trái: Logo VKIST + Tên viện */}
          <Box sx={{ display: 'flex', alignItems: 'center', gap: 1.5 }}>
            <Box
              component="img"
              src="/images/logo-2.png"
              alt="VKIST"
              sx={{ height: { xs: 36, sm: 44 }, width: 'auto', objectFit: 'contain' }}
            />
            <Box>
              <Typography variant="h5" color="primary" sx={{ fontWeight: 600, lineHeight: 1.2 }}>
                Robot HMI
              </Typography>
              <Typography variant="body2" color="text.secondary" sx={{ display: { xs: 'none', sm: 'block' } }}>
                Viện Khoa học và Công nghệ Việt Nam - Hàn Quốc
              </Typography>
            </Box>
          </Box>
          {/* Bên phải: Chip trạng thái robot + người dùng + Đăng xuất */}
          <Stack direction="row" spacing={1.5} sx={{ alignItems: 'center' }}>
            <Chip
              label={
                !hasSnapshot
                  ? 'Đang chờ dữ liệu...'
                  : stale
                    ? 'Mất tín hiệu (Stale)'
                    : !rosConnected
                      ? 'Robot: Offline'
                      : locStatus === 'lost'
                        ? 'Mất định vị'
                        : 'Robot: Online'
              }
              color={
                !hasSnapshot
                  ? 'default'
                  : stale || locStatus === 'lost'
                    ? 'warning'
                    : !rosConnected
                      ? 'error'
                      : 'success'
              }
              variant="outlined"
              size="small"
            />
            {user && (
              <Typography variant="body2" color="text.secondary" sx={{ display: { xs: 'none', md: 'block' } }}>
                <strong>{user.username}</strong>
              </Typography>
            )}
            <Button
              variant="outlined"
              color="error"
              size="small"
              disabled={logoutBusy}
              onClick={handleLogout}
            >
              {logoutBusy ? 'Đang đăng xuất...' : 'Đăng xuất'}
            </Button>
          </Stack>
        </Stack>
      </Box>
      {/* Thanh tab ngang thay cho menu Drawer ở góc phải trước đây */}
      <Box sx={{ bgcolor: 'background.paper', borderBottom: 1, borderColor: 'divider', px: { xs: 1, md: 2.5 } }}>
        <Tabs
          component="nav"
          aria-label="Menu chức năng chính"
          value={activeTab}
          variant="scrollable"
          scrollButtons="auto"
          allowScrollButtonsMobile
        >
          {navItems.map(([to, label]) => (
            <Tab
              key={to}
              value={to}
              label={label}
              component={NavLink}
              to={to}
              sx={{ textTransform: 'none', fontWeight: 600, minHeight: 48 }}
            />
          ))}
        </Tabs>
      </Box>
      {logoutError && (
        <Alert severity="error" sx={{ borderRadius: 0 }}>
          {logoutError}
        </Alert>
      )}
      {/* Vùng hiển thị nội dung trang con */}
      <Box component="main" sx={{ p: { xs: 2, md: 4 }, maxWidth: 1600, mx: 'auto' }}>
        <Outlet />
      </Box>
    </Box>
  );
}

