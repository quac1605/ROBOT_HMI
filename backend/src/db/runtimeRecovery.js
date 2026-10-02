import { withTransaction } from './transaction.js';

// Called once before an authority starts accepting robot requests. A DB row
// cannot prove that a pre-restart ROS goal is still executing; never replay it.
export async function reconcileInterruptedMissions(pool, { robotId = 'robot-01' } = {}) {
  return withTransaction(pool, async client => {
    const result = await client.query(
      "UPDATE missions SET status='failed',distance_remaining_m=NULL," +
      "error=$2,updated_at=now() WHERE robot_id=$1 " +
      "AND status IN ('accepted','executing','canceling') RETURNING id",
      [robotId, { code: 'SERVER_RESTART_RECONCILIATION_REQUIRED',
        message: 'Mission bị ngắt khi backend khởi động lại; không tự phát lại lệnh.' }]);
    for (const row of result.rows) {
      await client.query(
        'INSERT INTO events(event_type,robot_id,resource_ref,payload) ' +
        'VALUES($1,$2,$3,$4)',
        ['mission.restart.failed', robotId, { missionId: row.id }, {}]);
    }
    return result.rowCount;
  });
}
