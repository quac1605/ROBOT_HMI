import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { CssBaseline, ThemeProvider, createTheme } from '@mui/material';
import { BrowserRouter } from 'react-router';
import AuthProvider from './auth/AuthProvider.jsx';
import App from './App.jsx';
import './index.css';
import TelemetryBridge from './components/status/TelemetryBridge.jsx';


const theme = createTheme({
  palette: {
    primary: { main: '#195b78' },
    background: { default: '#f6f7f8' },
  },
  typography: {
    fontFamily: 'Arial, sans-serif',
  },
  shape: {
    borderRadius: 12,
  },
});

createRoot(document.getElementById('root')).render(
  <StrictMode>
    <ThemeProvider theme={theme}>
      <BrowserRouter>
        <AuthProvider>
          <TelemetryBridge /> {/* <-- Đặt ở đây */}
          <CssBaseline />
          <App />
        </AuthProvider>
      </BrowserRouter>
    </ThemeProvider>
  </StrictMode>,
);