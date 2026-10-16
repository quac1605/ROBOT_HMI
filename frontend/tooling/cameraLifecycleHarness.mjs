// Chỉ được test browser import; không nằm trong entrypoint/bundle ứng dụng.
// Import qua Vite để React/ReactDOM cùng dùng một module instance (có ?v hash).
import React from 'react';
import { createRoot } from 'react-dom/client';
import NavigationCameraPanel from '../src/components/navigation/NavigationCameraPanel.jsx';
export function mountCameraLifecycleHarness(host) {
  function Harness() {
    const [status, setStatus] = React.useState('Chưa nhận diện');
    return React.createElement(React.Fragment, null,
      React.createElement('button', {
        onClick: () => setStatus(s => s === 'Chưa nhận diện' ? 'Đã nhận diện' : 'Chưa nhận diện'),
        'data-testid': 'test-gesture-update',
      }, 'Update gesture'),
      React.createElement(NavigationCameraPanel, { gestureStatus: status }));
  }
  const root = createRoot(host);
  root.render(React.createElement(Harness));
  return root;
}
