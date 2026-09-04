import { Alert, Box, CircularProgress, Typography } from '@mui/material';
import { Navigate, Outlet, useLocation } from 'react-router';
import { useAuth } from './AuthContext.js';

export default function RequireAuth() {
  const { status, sessionError } = useAuth();
  const location = useLocation();

  if (status === 'checking') {
    return (
      <Box sx={{ display: 'flex', alignItems: 'center', justifyContent: 'center', minHeight: '60vh', gap: 2 }}>
        <CircularProgress size={24} />
        <Typography>Đang kiểm tra phiên đăng nhập...</Typography>
      </Box>
    );
  }

  if (status === 'error') {
    return <Alert severity="error">{sessionError}</Alert>;
  }

  // Nếu chưa đăng nhập, chuyển hướng về /login và nhớ trang hiện tại để quay lại sau
  if (status !== 'authenticated') {
    return <Navigate to="/login" replace state={{ from: location.pathname }} />;
  }

  return <Outlet />;
}
