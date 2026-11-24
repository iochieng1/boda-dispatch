"use client";

import type { CreateJobInput, Job } from "@boda-dispatch/shared";

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
