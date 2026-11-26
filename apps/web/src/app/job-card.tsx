"use client";

import {
  isTerminalStatus,
  type Job,
  type JobEdit,
  type JobEditField,
} from "@boda-dispatch/shared";
import type { FormEvent } from "react";

import { canUseMine, type SaveResult, saveJobEdit } from "@/lib/job-changes";
import { sendJobEdit } from "@/lib/jobs";

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
 * A card's in-progress edit, save and conflict. The board holds it, keyed by
 * job, because a status change moves the card to another column, which
 * remounts it, and an open edit or conflict prompt must survive that.
 */
export type CardState = {
  editing: { base: Job; draft: string } | null;
  pending: boolean;
  error: string | null;
  conflict: Conflict | null;
};

export const idleCard: CardState = {
  editing: null,
  pending: false,
  error: null,
  conflict: null,
};

function ConflictPrompt({
  conflict,
  pending,
  onKeepTheirs,
  onUseMine,
}: {
  conflict: Conflict;
  pending: boolean;
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
          disabled={pending}
          onClick={onKeepTheirs}
        >
          Keep theirs
        </button>
        {canUseMine(conflict) && (
          <button
            className="rounded bg-slate-900 px-2 py-1 text-white disabled:opacity-60"
            disabled={pending}
            onClick={onUseMine}
          >
            Use mine
          </button>
        )}
      </div>
    </div>
  );
}

/**
 * One job on the board, with an inline parcel edit and a cancel. A change is
 * based on the job as it was when the dispatcher started it; if the job moves
 * on before it is saved, the change is rebased, or the dispatcher is asked.
 */
export function JobCard({
  job,
  state,
  update,
  onChanged,
}: {
  job: Job;
  state: CardState;
  update: (change: Partial<CardState>) => void;
  /** Called with any newer copy of the job the server sends back. */
  onChanged: (job: Job) => void;
}) {
  const { editing, pending, error, conflict } = state;
  // While a conflict is open, the prompt decides; the form is frozen so
  // "use mine" sends exactly what the dispatcher sees.
  const locked = pending || conflict !== null;

  const save = async (base: Job, edit: JobEdit) => {
    update({ pending: true, error: null, conflict: null });
    try {
      const result = await saveJobEdit(base, edit, (e, v) =>
        sendJobEdit(job.id, e, v),
      );
      onChanged(result.kind === "saved" ? result.job : result.latest);
      switch (result.kind) {
        case "saved":
          return update({ ...idleCard });
        case "conflict":
          return update({ pending: false, conflict: result });
        case "refused":
          // Keep the draft, now based on the job as it is, to fix and retry.
          return update({
            pending: false,
            error: result.message,
            editing: editing && { ...editing, base: result.latest },
          });
      }
    } catch (err) {
      update({
        pending: false,
        error: err instanceof Error ? err.message : "Could not save the job",
      });
    }
  };

  const onSubmit = (event: FormEvent) => {
    event.preventDefault();
    if (!editing) return;
    const parcelDescription = editing.draft.trim();
    if (!parcelDescription) return update({ error: "Describe the parcel" });
    void save(editing.base, { parcelDescription });
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
            onClick={() => void save(job, { status: "CANCELLED" })}
          >
            Cancel job
          </button>
        </div>
      )}

      {conflict && (
        <ConflictPrompt
          conflict={conflict}
          pending={pending}
          onKeepTheirs={() => update({ ...idleCard })}
          onUseMine={() => void save(conflict.latest, conflict.edit)}
        />
      )}
      {error && (
        <p role="alert" className="mt-2 text-red-600">
          {error}
        </p>
      )}
    </li>
  );
}
