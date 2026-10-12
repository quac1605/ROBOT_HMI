/**
 * backend/src/services/jobService.js
 * 
 * DỊCH VỤ TRA CỨU VÀ STREAM TRẠNG THÁI JOBS (M8 / F8.3).
 */
import { JobSchema } from '@robot-hmi/contracts/job';
import { randomUUID } from 'node:crypto';

function jobDto(row) {
    return JobSchema.parse({
        jobId: row.id,
        type: row.kind,
        status: row.status,
        result: row.result ?? null,
        error: row.error ?? null,
        createdAt: new Date(row.created_at).toISOString(),
    });
}

export function createJobService({ pool, registry, lifecycle }) {
    let jobSequence = 0;

    async function createJob({ kind, principal }, client = pool, broadcast = true) {
        if (kind !== 'preview_route' || typeof principal !== 'string' || !principal) {
            throw Object.assign(new Error('INVALID_JOB_REQUEST'), {
                code: 'VALIDATION_ERROR', status: 400,
            });
        }
        const result = await client.query(
            "INSERT INTO jobs(id,kind,status,result,error,principal,dispatch_state) " +
            "VALUES($1,$2,'accepted',NULL,NULL,$3,'pending') RETURNING *",
            [randomUUID(), kind, principal],
        );
        const job = jobDto(result.rows[0]);
        // A transaction caller broadcasts only after its ledger commit.
        if (broadcast) broadcastJobUpdated(job);
        return job;
    }

    async function transitionJob(jobId, fromStatuses, status, result = null, error = null) {
        const updated = await pool.query(
            'UPDATE jobs SET status=$2,result=$3,error=$4,' +
            "dispatch_state=CASE WHEN $2='running' THEN 'running' ELSE 'done' END," +
            'updated_at=now() WHERE id=$1 AND kind=$5 AND status=ANY($6::text[]) RETURNING *',
            [jobId, status, result, error, 'preview_route', fromStatuses],
        );
        if (!updated.rowCount) {
            throw Object.assign(new Error('JOB_TRANSITION_REJECTED'), {
                code: 'JOB_TRANSITION_REJECTED', status: 409,
            });
        }
        const job = jobDto(updated.rows[0]);
        broadcastJobUpdated(job);
        return job;
    }

    function updateJobStatus(jobId, status) {
        if (status !== 'running') {
            throw Object.assign(new Error('JOB_TRANSITION_REJECTED'), {
                code: 'JOB_TRANSITION_REJECTED', status: 409,
            });
        }
        return transitionJob(jobId, ['accepted'], status);
    }

    function completeJob(jobId, result) {
        return transitionJob(jobId, ['running'], 'completed', result);
    }

    function failJob(jobId, error) {
        return transitionJob(jobId, ['accepted', 'running'], 'failed', null, error);
    }

    async function getJob(jobId) {
        if (!jobId || typeof jobId !== 'string') {
            throw Object.assign(new Error('JOB_NOT_FOUND'), { code: 'JOB_NOT_FOUND', status: 404 });
        }
        const res = await pool.query('SELECT * FROM jobs WHERE id = $1', [jobId]);
        if (!res.rowCount) {
            throw Object.assign(new Error('JOB_NOT_FOUND'), { code: 'JOB_NOT_FOUND', status: 404 });
        }
        return jobDto(res.rows[0]);
    }

    function broadcastJobUpdated(job) {
        if (!registry) return;
        const validJob = JobSchema.parse(job);
        const frame = {
            version: 1,
            type: 'job.updated',
            streamEpoch: lifecycle?.authBootEpoch || 'epoch-1',
            sequence: ++jobSequence,
            sentAt: new Date().toISOString(),
            payload: validJob,
        };
        registry.broadcastApp(frame);
    }

    async function updateJob(clientOrPool, jobId, {
        status, result = null, error = null,
        allowedStatuses = ['accepted', 'running'],
    }) {
        const res = await clientOrPool.query(
            'UPDATE jobs SET status = $2, result = $3, error = $4, updated_at = now() ' +
            'WHERE id = $1 AND status=ANY($5::text[]) RETURNING *',
            [jobId, status, result, error, allowedStatuses]
        );
        if (!res.rowCount) return null;
        const dto = jobDto(res.rows[0]);
        broadcastJobUpdated(dto);
        return dto;
    }

    return {
        createJob,
        updateJobStatus,
        completeJob,
        failJob,
        getJob,
        broadcastJobUpdated,
        updateJob,
    };
}
