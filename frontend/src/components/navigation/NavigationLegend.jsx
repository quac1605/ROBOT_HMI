import { Box, Stack, Typography } from '@mui/material';

const entries = [
  { label: 'Draft: ý định chưa gửi', color: '#ff9800', dashed: true },
  { label: 'Preview: đường minh họa', color: '#0288d1', dashed: true },
  { label: 'Planned: đường của mission mock', color: '#2e7d32' },
  { label: 'Trajectory: vết pose đã nhận', color: '#00bcd4' },
];
export default function NavigationLegend() {
  return (
    <Stack spacing={0.5} aria-label="Chú thích các lớp điều hướng">
      {entries.map(entry => <Stack key={entry.label} direction="row" spacing={1} sx={{ alignItems: 'center' }}>
        <Box sx={{ width: 24, borderBottom: '3px ' + (entry.dashed ? 'dashed ' : 'solid ') + entry.color }} />
        <Typography variant="caption">{entry.label}</Typography>
      </Stack>)}
      <Typography variant="caption">Marker robot: xanh = tin cậy; vàng = cũ; đỏ = mất định vị; xám = ngoại tuyến.</Typography>
    </Stack>
  );
}
