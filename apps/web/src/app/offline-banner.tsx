"use client";

import { countChanges } from "@/lib/outbox";

import { useOutbox } from "./outbox-provider";
import { useConnection } from "./socket-provider";

const changes = (n: number) => `${n} ${n === 1 ? "change" : "changes"}`;

/**
 * Says when the dashboard is offline and how many changes are waiting, so a
 * dispatcher knows their edits are kept and not lost.
 */
export function OfflineBanner() {
  const { status } = useConnection();
  const { mutations, reachable, problem } = useOutbox();
  const { waiting, attention } = countChanges(mutations);

  const offline =
    !reachable || status === "reconnecting" || status === "disconnected";

  if (!offline && waiting === 0 && attention === 0 && !problem) return null;

  return (
    <div
      role="status"
      aria-live="polite"
      className={`mt-4 rounded-lg border p-3 text-sm ${
        offline
          ? "border-amber-300 bg-amber-50 text-amber-900"
          : "border-slate-200 bg-white text-slate-700"
      }`}
    >
      {offline ? (
        <p className="font-medium">
          You&apos;re offline.{" "}
          {waiting > 0
            ? `${changes(waiting)} waiting to sync.`
            : "Changes you make are kept and sync when the connection returns."}
        </p>
      ) : (
        waiting > 0 && <p>Syncing {changes(waiting)}…</p>
      )}
      {attention > 0 && (
        <p className="mt-1 text-red-700">
          {changes(attention)} need{attention === 1 ? "s" : ""} your attention
          below.
        </p>
      )}
      {problem && <p className="mt-1 text-red-700">{problem}</p>}
    </div>
  );
}
