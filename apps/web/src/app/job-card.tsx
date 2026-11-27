"use client";

import {
  isTerminalStatus,
  type Job,
  type JobEdit,
  type JobEditField,
} from "@boda-dispatch/shared";
import type { FormEvent } from "react";

import { canUseMine, type SaveResult } from "@/lib/job-changes";
import type { QueuedMutation } from "@/lib/outbox";

import { useOutbox } from "./outbox-provider";

const FIELD_LABELS: Record<JobEditField, string> = {
  pickup: "Pickup",
  dropoff: "Drop-off",
  parcelDescription: "Parcel",
  status: "Status",
};

/** A field's value in an edit or a job, for showing side by side. */
const describe = (field: JobEditField, value: JobEdit | Job): string => {
  switch (field) {
    case "pickup":
    case "dropoff":
      return value[field]?.address ?? "";
    case "parcelDescription":
      return value.parcelDescription ?? "";
    case "status":
      return value.assignedRiderId
        ? `${value.status} (rider ${value.assignedRiderId.slice(0, 8)})`
        : (value.status ?? "");
  }
};

type Conflict = Extract<SaveResult, { kind: "conflict" }>;

/**
 * A card's in-progress edit. The board holds it, keyed by job, because a
 * status change moves the card to another column, which remounts it, and an
 * open edit must survive that. Saves and conflicts live in the outbox.
 */
export type CardState = {
  editing: { base: Job; draft: string } | null;
  error: string | null;
};

export const idleCard: CardState = { editing: null, error: null };

function ConflictPrompt({
  conflict,
  onKeepTheirs,
  onUseMine,
}: {
  conflict: Conflict;
  onKeepTheirs: () => void;
  onUseMine: () => void;
}) {
  return (
    <div
      role="alertdialog"
      aria-label="Conflicting change"
      className="mt-2 rounded border border-amber-300 bg-amber-50 p-2"
    >
      <p className="font-medium">Someone else changed this job meanwhile.</p>
      <dl className="mt-1 space-y-1">
        {conflict.fields.map((field) => (
          <div key={field}>
            <dt className="font-medium">{FIELD_LABELS[field]}</dt>
            <dd>Theirs: {describe(field, conflict.latest)}</dd>
            <dd>Yours: {describe(field, conflict.edit)}</dd>
          </div>
        ))}
      </dl>
      <div className="mt-2 flex gap-2">
        <button
          className="rounded border border-slate-300 bg-white px-2 py-1"
          onClick={onKeepTheirs}
        >
          Keep theirs
        </button>
        {canUseMine(conflict) && (
          <button
            className="rounded bg-slate-900 px-2 py-1 text-white"
            onClick={onUseMine}
          >
            Use mine
          </button>
        )}
      </div>
    </div>
  );
}

/** What went wrong with a queued change, and how to clear it. */
export function MutationProblem({ mutation }: { mutation: QueuedMutation }) {
  const { discard, applyOverLatest } = useOutbox();
  const { state } = mutation;

  if (state.kind === "conflict" && mutation.kind === "edit") {
    return (
      <ConflictPrompt
        conflict={{ ...state, edit: mutation.edit }}
        onKeepTheirs={() => void discard(mutation)}
        onUseMine={() => void applyOverLatest(mutation)}
      />
    );
  }
  if (state.kind === "pending") return null;
  return (
    <div role="alert" className="mt-2 text-red-600">
      <p>
        {state.kind === "refused" ? state.message : "Could not save"}
        {state.kind === "refused" &&
          Object.values(state.fieldErrors ?? {}).map((m) => ` ${m}`)}
      </p>
      <button className="underline" onClick={() => void discard(mutation)}>
        Dismiss
      </button>
    </div>
  );
}

/**
 * One job on the board, with an inline parcel edit and a cancel. `job` shows
 * the dispatcher's queued changes already applied. A change is queued in the
 * outbox, based on the job as it was when the dispatcher started it, and sent
 * when online; if the job moved on meanwhile it is rebased, or the dispatcher
 * is asked.
 */
export function JobCard({
  job,
  mutations,
  state,
  update,
}: {
  job: Job;
  /** This job's queued changes, oldest first. */
  mutations: QueuedMutation[];
  state: CardState;
  update: (change: Partial<CardState>) => void;
}) {
  const { enqueueEdit } = useOutbox();
  const { editing, error } = state;
  const waiting = mutations.filter((m) => m.state.kind === "pending").length;
  // The oldest unresolved change holds this job's later ones back, and new
  // ones wait until the dispatcher has dealt with it.
  const blocker = mutations.find((m) => m.state.kind !== "pending");
  const locked = blocker !== undefined;

  const queue = async (base: Job, edit: JobEdit) => {
    update({ error: null });
    try {
      await enqueueEdit(base, edit);
      update({ ...idleCard });
    } catch (err) {
      update({
        error: err instanceof Error ? err.message : "Could not save the job",
      });
    }
  };

  const onSubmit = (event: FormEvent) => {
    event.preventDefault();
    if (!editing) return;
    const parcelDescription = editing.draft.trim();
    if (!parcelDescription) return update({ error: "Describe the parcel" });
    void queue(editing.base, { parcelDescription });
  };

  const open = !isTerminalStatus(job.status);

  return (
    <li className="rounded border border-slate-200 bg-white p-3 text-sm shadow-sm">
      {editing ? (
        <form onSubmit={onSubmit} className="flex gap-2">
          <input
            aria-label="Parcel"
            className="min-w-0 flex-1 rounded border border-slate-300 px-2 py-1"
            value={editing.draft}
            onChange={(e) =>
              update({ editing: { ...editing, draft: e.target.value } })
            }
            disabled={locked}
            autoFocus
          />
          <button
            type="submit"
            className="rounded bg-slate-900 px-2 py-1 text-white disabled:opacity-60"
            disabled={locked}
          >
            Save
          </button>
          <button
            type="button"
            className="underline"
            onClick={() => update({ ...idleCard })}
          >
            Close
          </button>
        </form>
      ) : (
        <p className="font-medium">{job.parcelDescription}</p>
      )}
      <p className="mt-1 text-slate-600">{job.pickup.address}</p>
      <p className="text-slate-600">→ {job.dropoff.address}</p>

      {waiting > 0 && (
        <p className="mt-1 text-xs text-amber-700">
          Not synced yet{waiting > 1 ? ` (${waiting} changes)` : ""}
        </p>
      )}

      {open && !editing && (
        <div className="mt-2 flex gap-3 text-xs">
          <button
            className="underline disabled:opacity-60"
            disabled={locked}
            onClick={() =>
              update({
                error: null,
                editing: { base: job, draft: job.parcelDescription },
              })
            }
          >
            Edit
          </button>
          <button
            className="text-red-700 underline disabled:opacity-60"
            disabled={locked}
            onClick={() => void queue(job, { status: "CANCELLED" })}
          >
            Cancel job
          </button>
        </div>
      )}

      {blocker && <MutationProblem mutation={blocker} />}
      {error && (
        <p role="alert" className="mt-2 text-red-600">
          {error}
        </p>
      )}
    </li>
  );
}
