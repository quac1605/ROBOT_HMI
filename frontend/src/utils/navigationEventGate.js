export const emptyCursor = () => ({ streamEpoch: null, lastSequence: -1, retiredEpochs: [] });

// Epoch là ID opaque, không so >/< giữa hai chuỗi epoch.
export function gateEvent(cursor, event) {
    if (cursor.retiredEpochs.includes(event.streamEpoch)) return { action: 'ignore', cursor };
    if (cursor.streamEpoch === event.streamEpoch && event.sequence <= cursor.lastSequence) {
        return { action: 'ignore', cursor };
    }
    const changed = cursor.streamEpoch !== null && cursor.streamEpoch !== event.streamEpoch;
    return {
        action: changed ? 'recover' : 'accept',
        cursor: {
            streamEpoch: event.streamEpoch, lastSequence: event.sequence,
            retiredEpochs: changed ? [...cursor.retiredEpochs, cursor.streamEpoch] : cursor.retiredEpochs,
        },
    };
}
