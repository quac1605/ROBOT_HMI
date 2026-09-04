import { Box, Button, ButtonGroup, Paper, Stack, Typography } from '@mui/material';
import PageFrame from '../components/layout/PageFrame.jsx';

export default function TeleopPage() {
  return (
    <PageFrame title="Camera & điều khiển">
      <Stack spacing={2}>
        {/* Khung Camera tỷ lệ 16:9 */}
        <Paper
          variant="outlined"
          sx={{
            aspectRatio: '16/9',
            maxHeight: '60vh',
            width: '100%',
            mx: 'auto',
            bgcolor: '#222',
            color: '#fff',
            display: 'grid',
            placeItems: 'center',
            position: 'relative',
            borderRadius: 3,
            overflow: 'hidden',
          }}
        >
          {/* Nút chọn camera Trước / Sau */}
          <Box sx={{ position: 'absolute', top: 16, left: 16 }}>
            <ButtonGroup size="small" variant="contained">
              <Button>Trước</Button>
              <Button color="inherit" sx={{ bgcolor: 'grey.700' }}>Sau</Button>
            </ButtonGroup>
          </Box>
          <Typography color="grey.400">
            Luồng Video Camera mô phỏng — sẽ kết nối ở chặng 8
          </Typography>
        </Paper>

        {/* Các lệnh di chuyển chỉ được kích hoạt sau khi kết nối robot ở Chặng 8. */}
        <Stack spacing={2} sx={{ width: '100%' }}>
          <Typography variant="subtitle1" sx={{ fontWeight: 600, textAlign: 'center' }}>
            Điều khiển di chuyển
          </Typography>

          <Box
            sx={{
              width: '100%',
              boxSizing: 'border-box',
              display: 'flex',
              flexDirection: { xs: 'column', sm: 'row' },
              justifyContent: 'space-between',
              alignItems: 'center',
              gap: 3,
              p: 3,
              px: { xs: 3, md: 6 }, // Khoảng cách đệm 2 bên mép để Joystick và nút E-Stop không bị dính sát viền
              bgcolor: 'background.paper',
              borderRadius: 3,
              border: 1,
              borderColor: 'divider',
            }}
          >

            {/* Bên trái: Joystick điều khiển hướng */}
            <Stack spacing={1} sx={{ alignItems: 'center' }}>
              <Typography variant="subtitle2" color="text.secondary" sx={{ fontWeight: 600 }}>
                Cần điều khiển (Joystick)
              </Typography>
              <Box
                sx={{
                  width: 160,
                  height: 160,
                  borderRadius: '50%',
                  bgcolor: 'grey.100',
                  border: '2px dashed',
                  borderColor: 'grey.400',
                  position: 'relative',
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  boxShadow: 'inset 0 2px 8px rgba(0,0,0,0.06)',
                }}
              >
                {/* Nút Tiến (Trên) */}
                <Button
                  disabled
                  size="small"
                  variant="outlined"
                  sx={{ position: 'absolute', top: 8, minWidth: 44, height: 32, p: 0 }}
                >
                  ▲
                </Button>
                {/* Nút Lùi (Dưới) */}
                <Button
                  disabled
                  size="small"
                  variant="outlined"
                  sx={{ position: 'absolute', bottom: 8, minWidth: 44, height: 32, p: 0 }}
                >
                  ▼
                </Button>
                {/* Nút Quay trái */}
                <Button
                  disabled
                  size="small"
                  variant="outlined"
                  sx={{ position: 'absolute', left: 8, minWidth: 44, height: 32, p: 0 }}
                >
                  ◀
                </Button>
                {/* Nút Quay phải */}
                <Button
                  disabled
                  size="small"
                  variant="outlined"
                  sx={{ position: 'absolute', right: 8, minWidth: 44, height: 32, p: 0 }}
                >
                  ▶
                </Button>
                {/* Núm Joystick trung tâm */}
                <Box
                  sx={{
                    width: 56,
                    height: 56,
                    borderRadius: '50%',
                    bgcolor: 'grey.300',
                    border: '2px solid',
                    borderColor: 'grey.500',
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'center',
                    boxShadow: 2,
                    cursor: 'not-allowed',
                  }}
                >
                  <Typography variant="caption" sx={{ fontWeight: 700, color: 'text.secondary' }}>
                    JOY
                  </Typography>
                </Box>
              </Box>
              <Typography variant="caption" color="text.secondary">
                Bàn phím: W-A-S-D (Chặng 8)
              </Typography>
            </Stack>
            {/* Bên phải: Nút Dừng khẩn cấp kiểu công nghiệp (E-Stop) */}
            <Stack spacing={1} sx={{ alignItems: 'center' }}>
              <Typography variant="subtitle2" color="error" sx={{ fontWeight: 600 }}>
                An toàn khẩn cấp
              </Typography>
              <Button
                disabled
                variant="contained"
                color="error"
                sx={{
                  width: 120,
                  height: 120,
                  borderRadius: '50%',
                  fontWeight: 700,
                  fontSize: '0.95rem',
                  textAlign: 'center',
                  lineHeight: 1.3,
                  boxShadow: '0 4px 16px rgba(211, 47, 47, 0.4)',
                  border: '4px solid #b71c1c',
                  textTransform: 'uppercase',
                  display: 'flex',
                  flexDirection: 'column',
                  justifyContent: 'center',
                }}
              >
                <span>DỪNG</span>
                <span>KHẨN CẤP</span>
              </Button>
              <Typography variant="caption" color="text.secondary">
                Phím Space / Phanh gấp
              </Typography>
            </Stack>
          </Box>
        </Stack>
      </Stack>
    </PageFrame>
  );
}
