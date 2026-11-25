import { JOB_STATUSES, type Job, type JobStatus } from "@boda-dispatch/shared";

export type BoardState = {
  jobs: Record<string, Job>;
  /** Newest `updatedAt` seen from the API or a socket event; null before the first load. */
  lastSeen: string | null;
};

export const emptyBoard: BoardState = { jobs: {}, lastSeen: null };

/**
 * Merges jobs into the board. Live events and fetched pages can arrive twice
 * or out of order, so a job only replaces the copy we hold if its `version`
 * is higher; applying the same job again changes nothing.
 */
export const applyJobs = (state: BoardState, incoming: Job[]): BoardState => {
  let jobs = state.jobs;
  let lastSeen = state.lastSeen;

  for (const job of incoming) {
    if (!lastSeen || job.updatedAt > lastSeen) lastSeen = job.updatedAt;
    const held = jobs[job.id];
    if (held && held.version >= job.version) continue;
    if (jobs === state.jobs) jobs = { ...jobs };
    jobs[job.id] = job;
  }

  return jobs === state.jobs && lastSeen === state.lastSeen
    ? state
    : { jobs, lastSeen };
};

/**
 * Jobs are stamped with the time their transaction began, so one that began
 * earlier can commit after a later one we've already seen. Resyncing from a
 * little before `lastSeen` picks those up; applyJobs ignores the repeats.
 */
export const RESYNC_OVERLAP_MS = 10_000;

export const resyncSince = (lastSeen: string) =>
  new Date(Date.parse(lastSeen) - RESYNC_OVERLAP_MS).toISOString();

export const BOARD_COLUMNS: readonly JobStatus[] = JOB_STATUSES;

/** The jobs of each status, newest first. */
export const columnsOf = (state: BoardState) => {
  const columns = Object.fromEntries(
    BOARD_COLUMNS.map((status) => [status, [] as Job[]]),
  ) as Record<JobStatus, Job[]>;
  for (const job of Object.values(state.jobs)) columns[job.status].push(job);
  for (const jobs of Object.values(columns)) {
    jobs.sort(
      (a, b) =>
        b.createdAt.localeCompare(a.createdAt) || b.id.localeCompare(a.id),
    );
  }
  return columns;
};
