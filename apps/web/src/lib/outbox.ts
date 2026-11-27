import type {
  CreateJobInput,
  Job,
  JobEdit,
  JobEditField,
} from "@boda-dispatch/shared";

import { type SendResult, saveJobEdit } from "./job-changes";

/**
 * The outbox: every change the dispatcher makes is stored here first, then
 * sent. Offline, changes wait; on reconnect they replay in the order they were
 * made. Each carries a `clientMutationId` (its `id`), so a change whose ack
 * was lost and is sent again is applied once (the server dedupes on it).
 */

/** Where a queued change stands. */
export type MutationState =
  /** Waiting to be sent, or being sent. */
  | { kind: "pending" }
  /**
   * Someone else changed the same fields differently. `latest` is the job as
   * it is now; the dispatcher keeps it or applies the change over it.
   */
  | { kind: "conflict"; latest: Job; fields: JobEditField[] }
  /** The server refused the change for a reason a rebase can't fix. */
  | {
      kind: "refused";
      message: string;
      fieldErrors?: Record<string, string>;
      latest?: Job;
    };

export type QueuedMutation = {
  /** The clientMutationId: one per change, kept across every retry. */
  id: string;
  /** Queue position, assigned by the store; lower goes first. */
  seq: number;
  /** Changes are replayed only for the dispatcher who made them. */
  dispatcherId: string;
  queuedAt: string;
  state: MutationState;
} & (
  | { kind: "create"; input: CreateJobInput }
  | {
      kind: "edit";
      jobId: string;
      /**
       * The job as the dispatcher saw it when making the change, with their
       * own earlier queued changes applied. Its `version` is the server's.
       */
      base: Job;
      edit: JobEdit;
    }
);

export type NewMutation = DistributiveOmit<QueuedMutation, "seq">;
type DistributiveOmit<T, K extends PropertyKey> = T extends unknown
  ? Omit<T, K>
  : never;

/** Persistent storage for the outbox (IndexedDB in the browser). */
export interface MutationStore {
  /** The dispatcher's queued changes, oldest first. */
  list(dispatcherId: string): Promise<QueuedMutation[]>;
  /** Adds a change to the back of the queue. */
  add(mutation: NewMutation): Promise<QueuedMutation>;
  /** Replaces a stored change (matched by `seq`). */
  put(mutation: QueuedMutation): Promise<void>;
  remove(mutation: QueuedMutation): Promise<void>;
}

/** The API couldn't be reached, or is down for now: try again later. */
export class OfflineError extends Error {
  constructor(message = "The server can't be reached") {
    super(message);
  }
}

/** The session has ended: nothing can be sent until the dispatcher signs in. */
export class SignedOutError extends Error {
  constructor() {
    super("Your session has ended");
  }
}

/** A refusal from the API, with its per-field messages when it sent any. */
export class JobRequestError extends Error {
  constructor(
    message: string,
    readonly fieldErrors: Record<string, string> = {},
  ) {
    super(message);
  }
}

/**
 * How the outbox talks to the API. Both throw OfflineError when the request
 * may not have arrived (it is retried), SignedOutError when the session is
 * over, and JobRequestError when the API refused it for good.
 */
export type Transport = {
  create(input: CreateJobInput, clientMutationId: string): Promise<Job>;
  /** A 409 comes back as a result so the edit can be rebased. */
  edit(
    jobId: string,
    edit: JobEdit,
    baseVersion: number,
    clientMutationId: string,
  ): Promise<SendResult>;
};

export type Settled =
  | { kind: "saved"; job: Job }
  | Extract<MutationState, { kind: "conflict" | "refused" }>;

export type ReplayResult =
  /** Every change that could be sent was. */
  | "done"
  /** The API couldn't be reached; the rest of the queue waits. */
  | "offline"
  | "signed_out";

const sendOne = async (
  mutation: QueuedMutation,
  transport: Transport,
): Promise<Settled> => {
  if (mutation.kind === "create") {
    return {
      kind: "saved",
      job: await transport.create(mutation.input, mutation.id),
    };
  }
  const result = await saveJobEdit(mutation.base, mutation.edit, (edit, v) =>
    transport.edit(mutation.jobId, edit, v, mutation.id),
  );
  switch (result.kind) {
    case "saved":
      return result;
    case "conflict":
      return { kind: "conflict", latest: result.latest, fields: result.fields };
    case "refused":
      return {
        kind: "refused",
        message: result.message,
        latest: result.latest,
      };
  }
};

/** The job a change was about, if it was about one. */
export const jobIdOf = (mutation: QueuedMutation) =>
  mutation.kind === "edit" ? mutation.jobId : null;

/**
 * Sends the dispatcher's queued changes, oldest first, one at a time.
 *
 * - Saved: removed from the queue; `onSettled` gets the job as saved.
 * - Conflict or refused: kept, marked, for the dispatcher to resolve. Later
 *   changes to the same job wait behind it (they were made on top of it);
 *   changes to other jobs carry on.
 * - Offline or signed out: stops, and everything left waits for next time.
 *
 * Replaying after an interruption is safe: a change that reached the server
 * but whose answer was lost is recognised by its id and not applied again.
 */
export const replayQueue = async (
  store: MutationStore,
  dispatcherId: string,
  transport: Transport,
  onSettled: (mutation: QueuedMutation, settled: Settled) => void = () => {},
): Promise<ReplayResult> => {
  const held = new Set<string>();

  for (const mutation of await store.list(dispatcherId)) {
    const jobId = jobIdOf(mutation);
    if (mutation.state.kind !== "pending" || (jobId && held.has(jobId))) {
      if (jobId) held.add(jobId);
      continue;
    }

    let settled: Settled;
    try {
      settled = await sendOne(mutation, transport);
    } catch (err) {
      if (err instanceof OfflineError) return "offline";
      if (err instanceof SignedOutError) return "signed_out";
      // Anything else won't get better by retrying: show it, don't loop.
      settled = {
        kind: "refused",
        message: err instanceof Error ? err.message : "Could not save",
        ...(err instanceof JobRequestError && {
          fieldErrors: err.fieldErrors,
        }),
      };
    }

    if (settled.kind === "saved") {
      await store.remove(mutation);
    } else {
      await store.put({ ...mutation, state: settled });
      if (jobId) held.add(jobId);
    }
    onSettled(mutation, settled);
  }
  return "done";
};

/**
 * The job as the dispatcher expects it to be once their waiting changes are
 * saved, for showing on the board and as the base of their next change. The
 * version stays the server's. Conflicted and refused changes aren't applied:
 * the board shows what the server has until the dispatcher decides.
 */
export const withPendingEdits = (
  job: Job,
  mutations: readonly QueuedMutation[],
): Job => {
  let shown = job;
  for (const mutation of mutations) {
    if (
      mutation.kind !== "edit" ||
      mutation.jobId !== job.id ||
      mutation.state.kind !== "pending"
    ) {
      continue;
    }
    const { pickup, dropoff, parcelDescription, status, assignedRiderId } =
      mutation.edit;
    shown = {
      ...shown,
      ...(pickup && { pickup }),
      ...(dropoff && { dropoff }),
      ...(parcelDescription !== undefined && { parcelDescription }),
      ...(status && { status }),
      ...(assignedRiderId && { assignedRiderId }),
    };
  }
  return shown;
};

/** In-memory store: for tests, and when IndexedDB isn't available. */
export class MemoryMutationStore implements MutationStore {
  private rows: QueuedMutation[] = [];
  private nextSeq = 1;

  async list(dispatcherId: string) {
    return this.rows
      .filter((row) => row.dispatcherId === dispatcherId)
      .sort((a, b) => a.seq - b.seq)
      .map((row) => structuredClone(row));
  }

  async add(mutation: NewMutation) {
    const row = { ...structuredClone(mutation), seq: this.nextSeq++ };
    this.rows.push(row);
    return structuredClone(row);
  }

  async put(mutation: QueuedMutation) {
    this.rows = this.rows.map((row) =>
      row.seq === mutation.seq ? structuredClone(mutation) : row,
    );
  }

  async remove(mutation: QueuedMutation) {
    this.rows = this.rows.filter((row) => row.seq !== mutation.seq);
  }
}

/** Changes still to send, and changes the dispatcher must resolve. */
export const countChanges = (mutations: readonly QueuedMutation[]) => {
  const waiting = mutations.filter((m) => m.state.kind === "pending").length;
  return { waiting, attention: mutations.length - waiting };
};
