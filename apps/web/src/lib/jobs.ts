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
import { getSession, redirectToLogin } from "./session";

/** An API error with the server's per-field messages, when it sent any. */
export class JobRequestError extends Error {
  constructor(
    message: string,
    readonly fieldErrors: Record<string, string> = {},
  ) {
    super(message);
  }
}

export const createJob = async (input: CreateJobInput): Promise<Job> => {
  const session = await getSession();
  if (!session) {
    redirectToLogin();
    throw new JobRequestError("Your session has ended");
  }

  const res = await fetch("/api/jobs", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${session.accessToken}`,
    },
    body: JSON.stringify(input),
  });

  if (res.status === 401) {
    redirectToLogin();
    throw new JobRequestError("Your session has ended");
  }
  if (!res.ok) {
    const body = (await res.json().catch(() => ({}))) as {
      message?: string;
      issues?: { path: string; message: string }[];
    };
    throw new JobRequestError(
      body.message ?? "Could not create the job",
      Object.fromEntries(
        (body.issues ?? []).map(({ path, message }) => [path, message]),
      ),
    );
  }
  // The job exists now. Re-validating the response could only turn a created
  // job into an error message and invite a duplicate, so it is trusted.
  return (await res.json()) as Job;
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

/**
 * PATCHes a job once, based on `baseVersion`. A 409 comes back as a result,
 * not an error, so the caller can rebase; see saveJobEdit.
 */
export const sendJobEdit = async (
  jobId: string,
  edit: JobEdit,
  baseVersion: number,
): Promise<SendResult> => {
  const session = await getSession();
  if (!session) {
    redirectToLogin();
    throw new JobRequestError("Your session has ended");
  }

  const res = await fetch(`/api/jobs/${encodeURIComponent(jobId)}`, {
    method: "PATCH",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${session.accessToken}`,
    },
    body: JSON.stringify({ ...edit, baseVersion }),
  });

  if (res.status === 401) {
    redirectToLogin();
    throw new JobRequestError("Your session has ended");
  }
  const body: unknown = await res.json().catch(() => ({}));
  if (res.status === 409) {
    const conflict = jobConflictSchema.safeParse(body);
    if (conflict.success) return { kind: "conflict", conflict: conflict.data };
  }
  if (!res.ok) {
    const message = (body as { message?: string }).message;
    throw new JobRequestError(message ?? "Could not save the job");
  }
  return { kind: "ok", job: body as Job };
};
