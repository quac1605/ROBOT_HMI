import { useState } from 'react';
import {
  Alert, Button, Dialog, DialogActions, DialogContent, DialogTitle, Stack, TextField, Typography,
} from '@mui/material';
import { isInsideMap } from '../../utils/mapCoordinates.js';

// Đọc X, Y (m) và góc (°) người dùng nhập; trả theta theo rad trong khoảng [-π, π].
function readPosition(x, y, degrees, map) {
  if ([x, y, degrees].some(value => value.trim() === '')) throw new Error('Vui lòng nhập đầy đủ X, Y, góc quay.');
  const values = [Number(x), Number(y), Number(degrees)];
  if (!values.every(Number.isFinite)) throw new Error('Giá trị phải là số hữu hạn.');
  if (Math.abs(values[2]) > 36000) throw new Error('Góc quay nằm ngoài phạm vi số hợp lệ (-36000° đến 36000°).');
  let angle = values[2] % 360;
  if (angle > 180) angle -= 360;
  if (angle < -180) angle += 360;
  const position = { x: values[0], y: values[1], theta: angle * Math.PI / 180 };
  if (map && !isInsideMap(position, map)) throw new Error('Tọa độ nằm ngoài phạm vi hình học của bản đồ.');
  return position;
}

/**
 * Hỏi vị trí ước lượng của robot trước nhiệm vụ auto.
 * Vị trí này được gửi trong original_poss của các gói /cmd_in tiếp theo.
 */
export default function OriginalPositionDialog({ open, map, onCancel, onSubmit }) {
  const [x, setX] = useState('');
  const [y, setY] = useState('');
  const [degrees, setDegrees] = useState('');
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(false);

  async function submit(event) {
    event.preventDefault();
    setError(null);
    let position;
    try { position = readPosition(x, y, degrees, map); }
    catch (cause) { setError(cause.message); return; }
    setBusy(true);
    try { await onSubmit(position); }
    catch (cause) { setError(cause.message); }
    finally { setBusy(false); }
  }

  return (
    <Dialog open={open} onClose={busy ? undefined : onCancel} data-testid="original-position-dialog">
      <form onSubmit={submit}>
        <DialogTitle>Vị trí ban đầu của robot</DialogTitle>
        <DialogContent>
          <Stack spacing={1.5} sx={{ pt: 1 }}>
            <Typography variant="body2">
              Nhập vị trí hiện tại của robot trên bản đồ trước khi chạy tự động.
              Có thể chọn lại vị trí trên bản đồ trước nhiệm vụ AUTO tiếp theo.
            </Typography>
            <TextField label="X (m)" size="small" value={x} autoFocus onChange={event => setX(event.target.value)} />
            <TextField label="Y (m)" size="small" value={y} onChange={event => setY(event.target.value)} />
            <TextField label="Góc (°)" size="small" value={degrees} onChange={event => setDegrees(event.target.value)} />
            {error && <Alert severity="error">{error}</Alert>}
          </Stack>
        </DialogContent>
        <DialogActions>
          <Button onClick={onCancel} disabled={busy}>Hủy</Button>
          <Button type="submit" variant="contained" disabled={busy} data-testid="original-position-submit">
            Xác nhận và bắt đầu
          </Button>
        </DialogActions>
      </form>
    </Dialog>
  );
}
