import { JobSchema, NavigationJobEventSchema } from '../schemas/job.js';
import { navigationError } from '../utils/navigationPolicy.js';

export function createMockJobService() {
  const jobs = new Map();
  const listeners = new Set();
  let streamEpoch = crypto.randomUUID();
  let sequence = 0;
  let disposed = false;

  function publish(raw) {
    if (disposed) throw navigationError('SERVICE_DISPOSED', 'Job service đã dispose.');
    const job = JobSchema.parse(raw);
    jobs.set(job.jobId, structuredClone(job));
    const event = NavigationJobEventSchema.parse({
      version: 1, type: 'job.updated', streamEpoch, sequence: ++sequence,
      sentAt: new Date().toISOString(), payload: job,
    });
    for (const listener of listeners) {
      try { listener(structuredClone(event)); } catch (error) { console.error(error); }
    }
    return structuredClone(job);
  }

  return {
    createJob({ type }) {
      return publish({
        jobId: crypto.randomUUID(), type, status: 'accepted',
        result: null, error: null, createdAt: new Date().toISOString()
      });
    },
    updateJob(jobId, patch) {
      const old = this.getJob(jobId);
      if (['completed', 'failed'].includes(old.status)) return old;
      return publish({ ...old, ...patch });
    },
    getJob(jobId) {
      if (!jobs.has(jobId)) throw navigationError('JOB_NOT_FOUND', 'Không tìm thấy job.');
      return structuredClone(jobs.get(jobId));
    },
    subscribeJobs(listener) {
      if (disposed) throw navigationError('SERVICE_DISPOSED', 'Job service đã dispose.');
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    clear() {
      jobs.clear();
      listeners.clear();
      streamEpoch = crypto.randomUUID();
      sequence = 0;
    },
    dispose() { this.clear(); disposed = true; },
  };
}
