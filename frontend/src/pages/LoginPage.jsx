import { useRef, useState } from 'react';
import {
    Alert,
    Box,
    Button,
    InputAdornment,
    Paper,
    Stack,
    TextField,
    Typography,
} from '@mui/material';
import { useLocation, useNavigate } from 'react-router';
import { useAuth } from '../auth/AuthContext.js';
import { robotClient } from '../clients/index.js';

const allowedDestinations = new Set(['/status', '/mapping', '/navigation']);

export default function LoginPage() {
    const [username, setUsername] = useState('');
    const [password, setPassword] = useState('');
    const [showPassword, setShowPassword] = useState(false);
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState('');
    const pending = useRef(false);

    const { signIn } = useAuth();
    const location = useLocation();
    const navigate = useNavigate();

    async function handleSubmit(event) {
        event.preventDefault();
        if (pending.current) return;

        if (!username.trim() || !password) {
            setError('Hãy nhập đầy đủ tài khoản và mật khẩu.');
            return;
        }

        pending.current = true;
        setBusy(true);
        setError('');

        try {
            await signIn({ username: username.trim(), password });
            // Nếu trước đó người dùng định vào trang nào thì sau khi login đẩy về đúng trang đó
            const requested = location.state?.from;
            const target = requested === '/teleop' ? '/mapping' : requested;
            navigate(allowedDestinations.has(target) ? target : '/status', { replace: true });
        } catch (cause) {
            setError(cause.message);
        } finally {
            pending.current = false;
            setBusy(false);
        }
    }

    return (
        <Box component="main" sx={{ minHeight: '100dvh', display: 'flex', alignItems: 'center', p: { xs: 2, md: 6 } }}>
            <Box sx={{ width: '100%', maxWidth: 1200, mx: 'auto' }}>
                <Stack direction={{ xs: 'column', md: 'row' }} spacing={4} sx={{ alignItems: 'center' }}>
                    {/* Cột trái: Form đăng nhập */}
                    <Box sx={{ flex: 1, width: '100%', maxWidth: 450 }}>
                        <Stack component="form" spacing={2.5} onSubmit={handleSubmit}>
                            <Box sx={{ display: 'flex', alignItems: 'center', gap: 1.5 }}>
                                <Box
                                    component="img"
                                    src="/images/logo-2.png"
                                    alt="VKIST"
                                    sx={{ height: 48, width: 'auto', objectFit: 'contain' }}
                                />
                                <Box>
                                    <Typography variant="caption" color="text.secondary" sx={{ display: 'block' }}>
                                        BỘ KHOA HỌC VÀ CÔNG NGHỆ
                                    </Typography>
                                    <Typography variant="subtitle2" color="primary" sx={{ fontWeight: 600 }}>
                                        VIỆN KHOA HỌC VÀ CÔNG NGHỆ VIỆT NAM - HÀN QUỐC
                                    </Typography>
                                </Box>
                            </Box>

                            <Box>
                                <Typography component="h1" variant="h4" sx={{ fontWeight: 600, mb: 1 }}>
                                    Xin Chào
                                </Typography>
                                <Typography variant="body2" color="text.secondary">
                                    Xin hãy nhập thông tin theo yêu cầu
                                </Typography>
                            </Box>

                            {robotClient.kind === 'mock' && <Alert severity="info">
                                Tài khoản demo: <strong>admin</strong> / Mật khẩu: <strong>demo-only</strong>
                            </Alert>}

                            {error && <Alert severity="error">{error}</Alert>}

                            <TextField
                                id="login-username"
                                label="Tài khoản"
                                autoComplete="username"
                                value={username}
                                onChange={(e) => setUsername(e.target.value)}
                                disabled={busy}
                                fullWidth
                            />

                            <TextField
                                id="login-password"
                                label="Mật khẩu"
                                type={showPassword ? 'text' : 'password'}
                                autoComplete="current-password"
                                value={password}
                                onChange={(e) => setPassword(e.target.value)}
                                disabled={busy}
                                fullWidth
                                slotProps={{
                                    input: {
                                        endAdornment: (
                                            <InputAdornment position="end">
                                                <Button
                                                    type="button"
                                                    size="small"
                                                    onClick={() => setShowPassword((prev) => !prev)}
                                                >
                                                    {showPassword ? 'Ẩn' : 'Hiện'}
                                                </Button>
                                            </InputAdornment>
                                        ),
                                    },
                                }}
                            />

                            <Button
                                id="login-submit-btn"
                                type="submit"
                                variant="contained"
                                size="large"
                                fullWidth
                                disabled={busy}
                                sx={{ py: 1.2, fontWeight: 600 }}
                            >
                                {busy ? 'Đang đăng nhập...' : 'Đăng nhập'}
                            </Button>
                        </Stack>
                    </Box>

                    {/* Cột phải: Ảnh viện VKIST */}
                    <Box sx={{ flex: 1.2, width: '100%', display: { xs: 'none', md: 'block' } }}>
                        <Paper elevation={2} sx={{ borderRadius: 4, overflow: 'hidden', lineHeight: 0 }}>
                            <Box
                                component="img"
                                src="/images/vkist-building.jpg"
                                alt="VKIST Building"
                                sx={{ width: '100%', height: 480, objectFit: 'cover' }}
                            />
                        </Paper>
                    </Box>
                </Stack>
            </Box>
        </Box>
    );
}
