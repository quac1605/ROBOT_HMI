import { Box, Button, Paper, Stack, Typography } from '@mui/material';
import PageFrame from '../components/layout/PageFrame.jsx';

export default function NavigationPage() {
  return (
    <PageFrame title="Đi đến đích">
      <Stack spacing={2}>
        <Paper
          variant="outlined"
          sx={{
            minHeight: '60vh',
            display: 'grid',
            placeItems: 'center',
            bgcolor: '#f0f0f0',
            borderRadius: 3,
          }}
        >
          <Typography color="text.secondary">
            Vùng bản đồ điều hướng — sẽ bổ sung ở chặng 5–7
          </Typography>
        </Paper>

        <Stack direction={{ xs: 'column', sm: 'row' }} spacing={2} sx={{ alignItems: 'center' }}>
          <Box
            sx={{
              flex: 1,
              p: 1.5,
              border: 1,
              borderColor: 'divider',
              borderRadius: 2,
              bgcolor: 'background.paper',
              textAlign: 'center',
            }}
          >
            <Typography variant="body1">Đích: chưa chọn</Typography>
          </Box>
          <Button disabled variant="contained" sx={{ minWidth: 160 }}>
            Đi đến đích
          </Button>
        </Stack>
      </Stack>
    </PageFrame>
  );
}
