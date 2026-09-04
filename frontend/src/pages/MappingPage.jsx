import { Button, Paper, Stack, Typography } from '@mui/material';
import PageFrame from '../components/layout/PageFrame.jsx';

export default function MappingPage() {
  return (
    <PageFrame title="Xây dựng bản đồ">
      <Stack spacing={2}>
        <Paper variant="outlined" sx={{ 
            minHeight: '55vh', 
            display: 'grid', 
            placeItems: 'center', 
            bgcolor: '#f0f0f0', 
            borderRadius: 3,}}>
          <Typography>Vùng bản đồ mô phỏng — bổ sung ở chặng 5–6</Typography>
        </Paper>
        <Button disabled variant="contained" sx={{ alignSelf: 'center' }}>Xây dựng bản đồ</Button>
      </Stack>
    </PageFrame>
  );
}