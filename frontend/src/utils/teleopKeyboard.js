export function bindTeleopKeyboard({ target, start, stop, manualStop, vectorFor }) {
    const interactive = element => {
        if (element?.isContentEditable ||
            element?.closest?.('input, textarea, select, [role="textbox"], [contenteditable="true"]')) return true;
        // MUI Select là div role=combobox. Khi nó giữ focus, phím mũi tên
        // phải chọn bản đồ; Space/Enter trên tab hoặc nút phải kích hoạt UI.
        // Chỉ nút hướng của joystick được phép nhận Enter để lái.
        const control = element?.closest?.(
            '[role="combobox"], [role="listbox"], [role="option"], [role="menuitem"], button, [role="button"], [role="tab"]'
        );
        return Boolean(control && !control.hasAttribute?.('data-teleop-direction'));
    };

    const directions = {
        KeyW: 'forward',
        ArrowUp: 'forward',
        KeyS: 'backward',
        ArrowDown: 'backward',
        KeyA: 'left',
        ArrowLeft: 'left',
        KeyD: 'right',
        ArrowRight: 'right',
    };

    const onDown = event => {
        if (interactive(event.target) || event.isComposing || event.ctrlKey || event.altKey || event.metaKey) return;
        const button = event.target?.closest?.('[data-teleop-direction]');
        const direction = event.code === 'Enter' ? button?.dataset.teleopDirection : directions[event.code];
        if (event.code !== 'Space' && !direction) return;

        event.preventDefault();
        if (event.repeat) return;

        if (event.code === 'Space') {
            manualStop();
            return;
        }

        if (event.code === 'Enter' && button?.disabled) return;
        const vector = vectorFor(direction);
        if (vector) start(`key:${event.code}`, vector);
    };

    const onUp = event => {
        if (directions[event.code] || event.code === 'Enter') {
            stop('KEY_UP', `key:${event.code}`);
        }
    };

    target.addEventListener('keydown', onDown);
    target.addEventListener('keyup', onUp);

    return () => {
        target.removeEventListener('keydown', onDown);
        target.removeEventListener('keyup', onUp);
    };
}
