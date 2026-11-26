"use client";

import {
  type Job,
  jobEventSchema,
  type JobStatus,
} from "@boda-dispatch/shared";
import { useCallback, useEffect, useRef, useState } from "react";

import {
  applyJobs,
  BOARD_COLUMNS,
  columnsOf,
  emptyBoard,
  resyncSince,
} from "@/lib/job-board";
import { fetchJobChanges, fetchRecentJobs } from "@/lib/jobs";

import { type CardState, idleCard, JobCard } from "./job-card";
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
  const [board, setBoard] = useState(emptyBoard);
  const [error, setError] = useState<string | null>(null);
  const [loaded, setLoaded] = useState(false);
  const boardRef = useRef(board);
  const [cards, setCards] = useState<Record<string, CardState>>({});
  const updateCard = useCallback(
    (id: string, change: Partial<CardState>) =>
      setCards((all) => ({
        ...all,
        [id]: { ...(all[id] ?? idleCard), ...change },
      })),
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

  const columns = columnsOf(board);

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
                    state={cards[job.id] ?? idleCard}
                    update={(change) => updateCard(job.id, change)}
                    onChanged={(changed) => apply([changed])}
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
