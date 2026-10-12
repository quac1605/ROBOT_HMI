export function createControlStreamFence({ maxRetiredEpochs = 128 } = {}) {
    let active = true;
    let epoch = null;
    let sequence = 0;
    let revision = 0;
    let queryId = 0;
    const retired = new Set();

    function adopt(next) {
        if (epoch !== null && epoch !== next) {
            if (retired.size >= maxRetiredEpochs) {
                active = false;
                throw new Error('CONTROL_STREAM_EPOCH_BUDGET_EXCEEDED');
            }
            retired.add(epoch);
        }
        epoch = next;
        sequence = 0;
        revision++;
    }

    const current = ticket => active && ticket.id === queryId && ticket.revision === revision;

    return {
        beginQuery() {
            return { id: ++queryId, revision };
        },
        queryStillCurrent: current,
        event(envelope) {
            if (!active || retired.has(envelope.streamEpoch)) return 'drop';
            if (epoch === null) {
                adopt(envelope.streamEpoch);
            } else if (envelope.streamEpoch !== epoch) {
                adopt(envelope.streamEpoch);
                return 'recover'; // Cần xóa trạng thái cũ và query lại authoritative state
            }
            if (envelope.sequence <= sequence) return 'drop';
            sequence = envelope.sequence;
            revision++;
            return 'apply';
        },
        query(ticket, envelope) {
            if (!current(ticket) || envelope.type !== 'control.snapshot' || retired.has(envelope.streamEpoch)) {
                return false;
            }
            if (epoch !== envelope.streamEpoch) {
                adopt(envelope.streamEpoch);
            }
            if (envelope.sequence <= sequence) return false;
            sequence = envelope.sequence;
            revision++;
            return true;
        },
        dispose() {
            active = false;
            revision++;
            queryId++;
        },
    };
}
