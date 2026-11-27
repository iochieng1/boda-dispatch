"use client";

import type { QueuedMutation } from "@/lib/outbox";

import { MutationProblem } from "./job-card";

const describe = (mutation: QueuedMutation) =>
  mutation.kind === "create"
    ? `New job: ${mutation.input.parcelDescription}`
    : `Change to job ${mutation.jobId.slice(0, 8)}`;

/**
 * Queued changes that have no card on the board to show them: jobs created
 * offline (they get a card once the server has them) and changes to jobs the
 * board hasn't loaded.
 */
export function PendingChanges({ mutations }: { mutations: QueuedMutation[] }) {
  if (mutations.length === 0) return null;

  return (
    <section
      aria-label="Changes waiting to sync"
      className="mb-4 rounded-lg border border-slate-200 bg-white p-3 text-sm"
    >
      <h2 className="font-semibold">Waiting to sync</h2>
      <ul className="mt-2 space-y-2">
        {mutations.map((mutation) => (
          <li key={mutation.id}>
            <p>
              {describe(mutation)}
              {mutation.state.kind === "pending" && (
                <span className="text-amber-700"> · not synced yet</span>
              )}
            </p>
            <MutationProblem mutation={mutation} />
          </li>
        ))}
      </ul>
    </section>
  );
}
