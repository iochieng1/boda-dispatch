"use client";

import type { CreateJobInput, Job, JobPage } from "@boda-dispatch/shared";

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

const getPage = async (url: string): Promise<JobPage> => {
  const session = await getSession();
  if (!session) {
    redirectToLogin();
    throw new JobRequestError("Your session has ended");
  }
  const res = await fetch(url, {
    headers: { authorization: `Bearer ${session.accessToken}` },
  });
  if (res.status === 401) {
    redirectToLogin();
    throw new JobRequestError("Your session has ended");
  }
  if (!res.ok) throw new JobRequestError("Could not load the jobs");
  return (await res.json()) as JobPage;
};

/** Reads every page of `url` (up to `max` jobs), following the cursor. */
const getAll = async (url: string, max: number): Promise<Job[]> => {
  const jobs: Job[] = [];
  let cursor: string | null = null;
  do {
    const page: JobPage = await getPage(
      `${url}${cursor ? `&cursor=${cursor}` : ""}`,
    );
    jobs.push(...page.jobs);
    cursor = page.nextCursor;
  } while (cursor && jobs.length < max);
  return jobs;
};

/** The newest jobs, for the board's first load. */
export const fetchRecentJobs = () =>
  getAll(`/api/jobs?limit=${PAGE_SIZE}`, BOARD_LOAD_LIMIT);

/** Every job changed since `since`, for catching up after a reconnect. */
export const fetchJobChanges = (since: string) =>
  getAll(
    `/api/jobs/changes?limit=${PAGE_SIZE}&since=${encodeURIComponent(since)}`,
    Infinity,
  );
