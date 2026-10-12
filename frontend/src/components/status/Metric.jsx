import { Box, Typography } from '@mui/material';

export default function Metric({ label, value, unit, dense = false }) {
  const isMissing = value === null || value === undefined;
  // dense: dùng cỡ chữ nhỏ cho cửa sổ trạng thái nổi trên trang Điều hướng
  const variant = dense ? 'body2' : 'body1';

  return (
    <Box sx={{ display: 'flex', justifyContent: 'space-between', gap: 2 }}>
      <Typography variant={variant} color="text.secondary">{label}</Typography>
      <Typography
        variant={variant}
        sx={{
          fontVariantNumeric: 'tabular-nums',
          color: isMissing ? 'text.secondary' : 'text.primary',
          fontStyle: isMissing ? 'italic' : 'normal',
          fontWeight: isMissing ? 400 : 500,
        }}
      >
        {isMissing ? (dense ? '--' : 'Chưa có dữ liệu') : `${value}${unit ? ` ${unit}` : ''}`}
      </Typography>
    </Box>
  );
}
