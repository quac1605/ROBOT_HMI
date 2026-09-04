import { Box, Button, Paper, Stack, TextField, Typography } from '@mui/material';


export default function LoginPage() {
    return (
        <Box sx={{ minHeight: '100dvh', display: 'flex', alignItems: 'center', p: { xs: 2, md: 6 } }}>
            <Box sx={{ width: '100%', maxWidth: 1200, mx: 'auto' }}>
                <Stack direction={{ xs: 'column', md: 'row' }} spacing={4} sx={{ alignItems: 'center' }}>
                    {/* Cột trái: Form đăng nhập */}
                    <Box sx={{ flex: 1, width: '100%', maxWidth: 450 }}>
                        <Stack spacing={3}>
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

                            <TextField label="Tên đăng nhập" fullWidth disabled placeholder="admin" />
                            <TextField label="Mật khẩu" type="password" fullWidth disabled placeholder="••••••••" />

                            <Button variant="contained" size="large" fullWidth disabled>
                                Đăng nhập
                            </Button>
                            <Typography variant="caption" color="text.secondary" align="center">
                                * Chức năng xác thực sẽ được hoàn thiện ở Chặng 3
                            </Typography>
                        </Stack>
                    </Box>

                    {/* Cột phải: Ảnh viện VKIST */}
                    <Box sx={{ flex: 1.2, width: '100%', display: { xs: 'none', md: 'block' } }}>
                        <Paper
                            elevation={2}
                            sx={{
                                borderRadius: 4,
                                overflow: 'hidden',
                                lineHeight: 0,
                            }}
                        >
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
