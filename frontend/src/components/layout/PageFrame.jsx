import { Box, Typography } from '@mui/material';

export default function PageFrame({ title, children }) {
  return (
    <Box>
      <Typography component="h1" variant="h5" sx={{ mb: 2 }}>{title}</Typography>
      {children}
    </Box>
  );
}