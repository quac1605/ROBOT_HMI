// utils/motionAdmissionGate.js
export function createMotionAdmissionGate() {
    let epoch = 0;
    let locked = false;

    const fail = () => {
        throw Object.assign(
            new Error('MOTION_ADMISSION_BLOCKED'),
            { code: 'MOTION_ADMISSION_BLOCKED' },
        );
    };

    return {
        // Gọi ở đầu createMission / activateMap để lấy ticket TRƯỚC await
        enter() {
            if (locked) fail();
            return epoch;
        },

        // Gọi SAU mỗi await và ngay TRƯỚC khi claim robot state
        // Nếu stop đã chạy trong lúc đang await → throw
        assert(ticket) {
            if (locked || ticket !== epoch) fail();
        },

        // Gọi khi bắt đầu requestStop
        // Tăng epoch để tất cả ticket cũ trở thành stale
        beginStop() {
            locked = true;
            return ++epoch;
        },

        // Gọi sau khi stop observation xác nhận
        confirmStop(ticket) {
            if (ticket !== epoch) return false;
            locked = false;
            return true;
        },

        // Chỉ gọi tại auth lifecycle (logout/login) sau khi timer đã bị hủy
        reset() {
            epoch += 1;
            locked = false;
        },
    };
}
