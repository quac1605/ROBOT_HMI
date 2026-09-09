import {
  Alert,
  Box,
  Button,
  Chip,
  Divider,
  Drawer,
  IconButton,
  List,
  ListItem,
  ListItemButton,
  ListItemText,
  Stack,
  Typography,
} from '@mui/material';
import { NavLink, Outlet, useNavigate } from 'react-router';
import { useState } from 'react';
import { useAuth } from '../../auth/AuthContext.js';
import { useRobotStore } from '../../stores/robotStore.js';
import { useRobotFreshness } from '../../hooks/useRobotFreshness.js';

const navItems = [
  ['/status', 'Trạng thái'],
  ['/mapping', 'Xây dựng bản đồ'],
  ['/navigation', 'Đi đến đích'],
  ['/teleop', 'Camera & điều khiển'],
];

export default function AppShell() {
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [logoutBusy, setLogoutBusy] = useState(false);
  const [logoutError, setLogoutError] = useState('');
  const { user, signOut } = useAuth();
  const navigate = useNavigate();

  // Đọc trạng thái từ store và độ tươi telemetry
  const hasSnapshot = useRobotStore((state) => state.snapshot !== null);
  const rosConnected = useRobotStore((state) => state.snapshot?.rosConnected);
  const locStatus = useRobotStore((state) => state.snapshot?.localization?.status);
  const { stale } = useRobotFreshness(2000);

  const toggleDrawer = (open) => (event) => {
    if (event.type === 'keydown' && (event.key === 'Tab' || event.key === 'Shift')) {
      return;
    }
    setDrawerOpen(open);
  };

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
          borderBottom: 1,
          borderColor: 'divider',
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
              <Typography variant="body2" color="text.secondary">
                Viện Khoa học và Công nghệ Việt Nam - Hàn Quốc
              </Typography>
            </Box>
          </Box>
          {/* Bên phải: Chip mô phỏng + Nút Hamburger Menu (khớp slide PowerPoint) */}
          <Stack direction="row" spacing={2} sx={{ alignItems: 'center' }}>
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
            <IconButton
              aria-label="Mở menu chức năng"
              onClick={toggleDrawer(true)}
              edge="end"
              size="large"
              color="inherit"
            >
              {/* Icon 3 gạch SVG chuẩn, không cần cài thêm icon package */}
              <svg width="28" height="28" viewBox="0 0 24 24" fill="currentColor">
                <path d="M3 18h18v-2H3v2zm0-5h18v-2H3v2zm0-7v2h18V6H3z" />
              </svg>
            </IconButton>
          </Stack>
        </Stack>
      </Box>
      {/* MUI Drawer trượt ra từ cạnh phải màn hình */}
      <Drawer
        anchor="right"
        open={drawerOpen}
        onClose={toggleDrawer(false)}
        slotProps={{
          paper: { sx: { width: 280 } },
        }}
      >
        <Box sx={{ p: 2, display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
          <Typography variant="h6" color="primary" sx={{ fontWeight: 600 }}>
            Chức năng
          </Typography>
          <IconButton aria-label="Đóng menu" onClick={toggleDrawer(false)} size="small">
            ✕
          </IconButton>
        </Box>
        <Divider />
        <List component="nav" aria-label="Menu chức năng chính" sx={{ p: 1 }}>
          {navItems.map(([to, label]) => (
            <ListItem key={to} disablePadding sx={{ mb: 0.5 }}>
              <ListItemButton
                component={NavLink}
                to={to}
                onClick={toggleDrawer(false)} // Tự động đóng drawer khi người dùng chọn trang
                sx={{
                  borderRadius: 2,
                  '&.active': {
                    bgcolor: 'primary.main',
                    color: 'primary.contrastText',
                    '&:hover': { bgcolor: 'primary.dark' },
                  },
                }}
              >
                <ListItemText primary={label} />
              </ListItemButton>
            </ListItem>
          ))}
        </List>
        <Divider />
        {/* Nút Đăng xuất ở cuối menu */}
        <Box sx={{ p: 2, mt: 'auto' }}>
          {user && (
            <Typography variant="body2" color="text.secondary" sx={{ mb: 1 }}>
              Đang đăng nhập: <strong>{user.username}</strong>
            </Typography>
          )}
          {logoutError && (
            <Alert severity="error" sx={{ mb: 1.5 }}>
              {logoutError}
            </Alert>
          )}
          <Button
            variant="outlined"
            color="error"
            fullWidth
            disabled={logoutBusy}
            onClick={handleLogout}
          >
            {logoutBusy ? 'Đang đăng xuất...' : 'Đăng xuất'}
          </Button>
        </Box>
      </Drawer>
      {/* Vùng hiển thị nội dung trang con */}
      <Box component="main" sx={{ p: { xs: 2, md: 4 }, maxWidth: 1600, mx: 'auto' }}>
        <Outlet />
      </Box>
    </Box>
  );
}

