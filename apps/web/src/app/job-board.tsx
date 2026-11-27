"use client";

import {
  type Job,
  jobEventSchema,
  type JobStatus,
} from "@boda-dispatch/shared";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import {
  applyJobs,
  BOARD_COLUMNS,
  columnsOf,
  emptyBoard,
  resyncSince,
} from "@/lib/job-board";
import { fetchJobChanges, fetchRecentJobs } from "@/lib/jobs";
import { jobIdOf, type QueuedMutation, withPendingEdits } from "@/lib/outbox";

import { type CardState, idleCard, JobCard } from "./job-card";
import { useOutbox } from "./outbox-provider";
import { PendingChanges } from "./pending-changes";
import { useConnection } from "./socket-provider";

const COLUMN_TITLES: Record<JobStatus, string> = {
  CREATED: "New",
  ASSIGNED: "Assigned",
  PICKED_UP: "Picked up",
  DELIVERED: "Delivered",
  CANCELLED: "Cancelled",
};

/**
 * The live board. Jobs load once over HTTP, then stay current from socket
 * events. After every reconnect it fetches what changed since the newest
 * update it has seen, because events sent while disconnected are gone.
 */
export function JobBoard() {
  const { socket } = useConnection();
  const { mutations, subscribe } = useOutbox();
  const [board, setBoard] = useState(emptyBoard);
  const [error, setError] = useState<string | null>(null);
  const [loaded, setLoaded] = useState(false);
  const boardRef = useRef(board);
  const [cards, setCards] = useState<Record<string, CardState>>({});
  const updateCard = useCallback(
    (id: string, change: Partial<CardState>) =>
      setCards((all) => {
        const { [id]: held = idleCard, ...rest } = all;
        const next = { ...held, ...change };
        // Idle cards aren't stored, so the map only holds cards in use.
        const idle = (Object.keys(idleCard) as (keyof CardState)[]).every(
          (key) => next[key] === idleCard[key],
        );
        return idle ? rest : { ...rest, [id]: next };
      }),
    [],
  );

  const apply = useCallback((jobs: Job[]) => {
    boardRef.current = applyJobs(boardRef.current, jobs);
    setBoard(boardRef.current);
  }, []);

  // `sync` is the first load or, once we have seen jobs, the catch-up.
  const hasLoaded = useRef(false);
  const syncing = useRef(false);
  const again = useRef(false);
  const sync = useCallback(async () => {
    // A connect during a sync queues one more run instead of racing it.
    if (syncing.current) {
      again.current = true;
      return;
    }
    syncing.current = true;
    try {
      do {
        again.current = false;
        const { lastSeen } = boardRef.current;
        apply(
          lastSeen && hasLoaded.current
            ? await fetchJobChanges(resyncSince(lastSeen))
            : await fetchRecentJobs(),
        );
        hasLoaded.current = true;
        setLoaded(true);
        setError(null);
      } while (again.current);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not load the jobs");
    } finally {
      syncing.current = false;
    }
  }, [apply]);

  useEffect(() => {
    if (!socket) return;

    const onJob = (payload: unknown) => {
      const parsed = jobEventSchema.safeParse(payload);
      if (parsed.success) apply([parsed.data.job]);
    };

    socket.on("job:created", onJob);
    socket.on("job:updated", onJob);
    // Fires on the first connection and on every reconnection.
    socket.on("connect", sync);
    if (socket.connected) void sync();

    return () => {
      socket.off("job:created", onJob);
      socket.off("job:updated", onJob);
      socket.off("connect", sync);
    };
  }, [socket, apply, sync]);

  // Jobs the server sends back for queued changes land like any other.
  useEffect(() => subscribe((job) => apply([job])), [subscribe, apply]);

  const byJob = useMemo(() => {
    const map: Record<string, QueuedMutation[]> = {};
    for (const mutation of mutations) {
      const id = jobIdOf(mutation);
      if (id) (map[id] ??= []).push(mutation);
    }
    return map;
  }, [mutations]);

  // The board shows each job with the dispatcher's waiting changes applied,
  // so an edit made offline is visible (and a queued cancel moves the card).
  const shown = useMemo(() => {
    const jobs = { ...board.jobs };
    for (const [id, queued] of Object.entries(byJob)) {
      const job = jobs[id];
      if (job) jobs[id] = withPendingEdits(job, queued);
    }
    return { ...board, jobs };
  }, [board, byJob]);

  const columns = columnsOf(shown);
  // Changes with no card to show them on: new jobs, and jobs not loaded.
  const unplaced = mutations.filter((m) => {
    const id = jobIdOf(m);
    return !id || (loaded && !board.jobs[id]);
  });

  return (
    <section className="mt-6" aria-label="Job board">
      {error && (
        <p className="mb-3 text-sm text-red-600" role="alert">
          {error}{" "}
          <button className="underline" onClick={() => void sync()}>
            Retry
          </button>
        </p>
      )}
      <PendingChanges mutations={unplaced} />
      {!loaded && !error && <p className="text-slate-500">Loading jobs…</p>}
      {loaded && (
        <div className="grid grid-cols-1 gap-4 md:grid-cols-5">
          {BOARD_COLUMNS.map((status) => (
            <div key={status}>
              <h2 className="mb-2 text-sm font-semibold uppercase text-slate-600">
                {COLUMN_TITLES[status]}{" "}
                <span className="font-normal">({columns[status].length})</span>
              </h2>
              <ul className="space-y-2">
                {columns[status].map((job) => (
                  <JobCard
                    key={job.id}
                    job={job}
                    mutations={byJob[job.id] ?? []}
                    state={cards[job.id] ?? idleCard}
                    update={(change) => updateCard(job.id, change)}
                  />
                ))}
              </ul>
            </div>
          ))}
        </div>
      )}
    </section>
  );
}
