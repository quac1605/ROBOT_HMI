export function bindTeleopKeyboard({ target, start, stop, manualStop, vectorFor }) {
    const editable = element => Boolean(
        element?.isContentEditable ||
        element?.closest?.('input, textarea, select, [role="textbox"], [contenteditable="true"]')
    );

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
        if (editable(event.target) || event.isComposing || event.ctrlKey || event.altKey || event.metaKey) return;
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
