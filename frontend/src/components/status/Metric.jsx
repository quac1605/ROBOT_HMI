import { Box, Typography } from '@mui/material';

export default function Metric({ label, value, unit }) {
  const isMissing = value === null || value === undefined;

  return (
    <Box sx={{ display: 'flex', justifyContent: 'space-between', gap: 2 }}>
      <Typography color="text.secondary">{label}</Typography>
      <Typography
        sx={{
          fontVariantNumeric: 'tabular-nums',
          color: isMissing ? 'text.secondary' : 'text.primary',
          fontStyle: isMissing ? 'italic' : 'normal',
        }}
      >
        {isMissing ? 'Chưa có dữ liệu' : `${value}${unit ? ` ${unit}` : ''}`}
      </Typography>
    </Box>
  );
}
