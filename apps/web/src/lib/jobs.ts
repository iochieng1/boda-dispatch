"use client";

import {
  type CreateJobInput,
  type Job,
  type JobChangesPage,
  jobConflictSchema,
  type JobEdit,
  type JobPage,
} from "@boda-dispatch/shared";

import type { SendResult } from "./job-changes";
import {
  JobRequestError,
  OfflineError,
  SignedOutError,
  type Transport,
} from "./outbox";
import { getSession, redirectToLogin } from "./session";

export { JobRequestError };

type ErrorBody = {
  message?: string;
  issues?: { path: string; message: string }[];
};

const SEND_TIMEOUT_MS = 20_000;

/**
 * Answers that mean "not now" rather than "no": the proxy's 502 when the API
 * is unreachable, the API restarting, timeouts and rate limits.
 */
const TRANSIENT_STATUSES = new Set([408, 425, 429, 502, 503, 504]);

/**
 * Sends one change to the API through the dashboard's proxy. A request that
 * may not have arrived, or that the API couldn't handle right now (see
 * TRANSIENT_STATUSES), is an OfflineError:
 * the outbox keeps the change and sends it again later, and its
 * clientMutationId stops a second copy from being applied.
 */
const sendChange = async (
  path: string,
  method: "POST" | "PATCH",
  body: Record<string, unknown>,
): Promise<Response> => {
  let session;
  try {
    session = await getSession();
  } catch {
    // Refreshing the token needs the network too.
    throw new OfflineError();
  }
  if (!session) {
    redirectToLogin();
    throw new SignedOutError();
  }

  let res: Response;
  try {
    res = await fetch(path, {
      method,
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${session.accessToken}`,
      },
      body: JSON.stringify(body),
      // A request stalled on a bad mobile network must not hold the queue
      // (and its cross-tab lock) forever.
      signal: AbortSignal.timeout(SEND_TIMEOUT_MS),
    });
  } catch {
    throw new OfflineError();
  }

  if (res.status === 401) {
    redirectToLogin();
    throw new SignedOutError();
  }
  if (TRANSIENT_STATUSES.has(res.status)) throw new OfflineError();
  if (res.status >= 500) {
    // The API is up but failed on this change. Retrying it in a loop would
    // hold every later change back, so it is shown with a "Try again".
    throw new JobRequestError("The server couldn't save this change");
  }
  return res;
};

const refusal = async (res: Response, fallback: string) => {
  const body = (await res.json().catch(() => ({}))) as ErrorBody;
  return new JobRequestError(
    body.message ?? fallback,
    Object.fromEntries(
      (body.issues ?? []).map(({ path, message }) => [path, message]),
    ),
  );
};

const createJob = async (
  input: CreateJobInput,
  clientMutationId: string,
): Promise<Job> => {
  const res = await sendChange("/api/jobs", "POST", {
    ...input,
    clientMutationId,
  });
  if (!res.ok) throw await refusal(res, "Could not create the job");
  // The job exists now. Re-validating the response could only turn a created
  // job into an error message, so it is trusted.
  return (await res.json()) as Job;
};

/**
 * PATCHes a job once, based on `baseVersion`. A 409 comes back as a result,
 * not an error, so the caller can rebase; see saveJobEdit.
 */
const sendJobEdit = async (
  jobId: string,
  edit: JobEdit,
  baseVersion: number,
  clientMutationId: string,
): Promise<SendResult> => {
  const res = await sendChange(
    `/api/jobs/${encodeURIComponent(jobId)}`,
    "PATCH",
    { ...edit, baseVersion, clientMutationId },
  );
  if (res.status === 409) {
    const body: unknown = await res
      .clone()
      .json()
      .catch(() => ({}));
    const conflict = jobConflictSchema.safeParse(body);
    if (conflict.success) return { kind: "conflict", conflict: conflict.data };
  }
  if (!res.ok) throw await refusal(res, "Could not save the job");
  return { kind: "ok", job: (await res.json()) as Job };
};

/** The outbox's way to the API. */
export const apiTransport: Transport = {
  create: createJob,
  edit: sendJobEdit,
};

/** The most jobs the board loads on first sight; older ones stay in the API. */
export const BOARD_LOAD_LIMIT = 500;
const PAGE_SIZE = 100;

const getPage = async <P extends JobPage | JobChangesPage>(
  path: string,
  params: Record<string, string>,
): Promise<P> => {
  const session = await getSession();
  if (!session) {
    redirectToLogin();
    throw new JobRequestError("Your session has ended");
  }
  const res = await fetch(`${path}?${new URLSearchParams(params)}`, {
    headers: { authorization: `Bearer ${session.accessToken}` },
  });
  if (res.status === 401) {
    redirectToLogin();
    throw new JobRequestError("Your session has ended");
  }
  if (!res.ok) throw new JobRequestError("Could not load the jobs");
  return (await res.json()) as P;
};

/** Reads every page, following the cursor, until `max` jobs are in hand. */
const getAll = async (
  path: string,
  params: Record<string, string>,
  max: number,
): Promise<Job[]> => {
  const jobs: Job[] = [];
  let cursor: string | null = null;
  do {
    const query: Record<string, string> = cursor
      ? { ...params, cursor }
      : params;
    const page: JobPage | JobChangesPage = await getPage(path, query);
    jobs.push(...page.jobs);
    cursor = page.nextCursor;
  } while (cursor && jobs.length < max);
  return jobs;
};

/** The newest jobs, for the board's first load. */
export const fetchRecentJobs = () =>
  getAll("/api/jobs", { limit: String(PAGE_SIZE) }, BOARD_LOAD_LIMIT);

/** Every job changed since `since`, for catching up after a reconnect. */
export const fetchJobChanges = (since: string) =>
  getAll("/api/jobs/changes", { limit: String(PAGE_SIZE), since }, Infinity);
