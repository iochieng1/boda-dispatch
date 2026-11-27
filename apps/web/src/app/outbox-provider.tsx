"use client";

import type { CreateJobInput, Job, JobEdit } from "@boda-dispatch/shared";
import {
  createContext,
  type ReactNode,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";

import { apiTransport } from "@/lib/jobs";
import {
  type MutationStore,
  type QueuedMutation,
  type ReplayResult,
  replayQueue,
} from "@/lib/outbox";
import { openMutationStore } from "@/lib/outbox-store";
import { getSession, onSessionChange } from "@/lib/session";

import { useConnection } from "./socket-provider";

/** While the API is unreachable, try the queue again this often. */
const RETRY_MS = 15_000;
const LOCK = "boda-dispatch:outbox";
const CHANNEL = "boda-dispatch:outbox";

export type CreateOutcome =
  /** `job` is null when another tab sent it, so this one never saw it. */
  | { kind: "created"; job: Job | null }
  /** Offline: the job will be created when the connection returns. */
  | { kind: "queued" }
  | { kind: "refused"; message: string; fieldErrors: Record<string, string> };

type Outbox = {
  /** The dispatcher's queued changes, oldest first. */
  mutations: QueuedMutation[];
  /** False after a send found the API unreachable, until one gets through. */
  reachable: boolean;
  /** Set when the queue itself couldn't be read or written. */
  problem: string | null;
  enqueueEdit(base: Job, edit: JobEdit): Promise<void>;
  /** Queues a new job and, when online, waits to say whether it was made. */
  enqueueCreate(input: CreateJobInput): Promise<CreateOutcome>;
  /** Drops a change (for a conflict: keeps theirs). */
  discard(mutation: QueuedMutation): Promise<void>;
  /** After a conflict: applies the change over the job as it is now. */
  applyOverLatest(mutation: QueuedMutation): Promise<void>;
  /** After a refusal: sends the change again as it is. */
  retry(mutation: QueuedMutation): Promise<void>;
  /** Called with each job the server sends back for a queued change. */
  subscribe(listener: (job: Job) => void): () => void;
};

const OutboxContext = createContext<Outbox | null>(null);

export const useOutbox = () => {
  const outbox = useContext(OutboxContext);
  if (!outbox) throw new Error("useOutbox needs an OutboxProvider");
  return outbox;
};

/** One tab replays at a time; the server would dedupe, but prompts wouldn't. */
const withOutboxLock = <T,>(fn: () => Promise<T>): Promise<T> =>
  typeof navigator !== "undefined" && navigator.locks
    ? (navigator.locks.request(LOCK, fn) as Promise<T>)
    : fn();

const messageOf = (err: unknown, fallback: string) =>
  err instanceof Error ? err.message : fallback;

/**
 * Owns the outbox: stores each change before sending it, replays the queue in
 * order on every (re)connect, and tells the board what the server answered.
 * Tabs share the queue (IndexedDB), take turns replaying it (a Web Lock) and
 * tell each other when it changes (a BroadcastChannel).
 */
export function OutboxProvider({ children }: { children: ReactNode }) {
  const { socket } = useConnection();
  const [mutations, setMutations] = useState<QueuedMutation[]>([]);
  const [reachable, setReachable] = useState(true);
  const [problem, setProblem] = useState<string | null>(null);

  const storeRef = useRef<Promise<MutationStore> | null>(null);
  const dispatcherId = useRef<string | null>(null);
  const listeners = useRef(new Set<(job: Job) => void>());
  const waiters = useRef(new Map<string, (outcome: CreateOutcome) => void>());
  const channel = useRef<BroadcastChannel | null>(null);
  const retryTimer = useRef<ReturnType<typeof setTimeout> | undefined>(
    undefined,
  );
  const flushing = useRef(false);
  const again = useRef(false);

  const store = useCallback(
    () => (storeRef.current ??= openMutationStore()),
    [],
  );

  const reload = useCallback(async () => {
    const id = dispatcherId.current;
    if (!id) return;
    try {
      setMutations(await (await store()).list(id));
    } catch (err) {
      setProblem(messageOf(err, "Could not read pending changes"));
    }
  }, [store]);

  /** After writing to the queue: refresh this tab and tell the others. */
  const changed = useCallback(async () => {
    await reload();
    channel.current?.postMessage("changed");
  }, [reload]);

  const flush = useCallback(async () => {
    const id = dispatcherId.current;
    if (!id) return;
    // A trigger during a replay queues one more pass instead of racing it.
    if (flushing.current) {
      again.current = true;
      return;
    }
    flushing.current = true;
    clearTimeout(retryTimer.current);

    try {
      let result: ReplayResult;
      do {
        again.current = false;
        result = await withOutboxLock(async () =>
          replayQueue(await store(), id, apiTransport, (mutation, settled) => {
            const job = settled.kind === "saved" ? settled.job : settled.latest;
            if (job) for (const listener of listeners.current) listener(job);

            const resolve = waiters.current.get(mutation.id);
            if (!resolve) return;
            waiters.current.delete(mutation.id);
            if (settled.kind === "saved") {
              resolve({ kind: "created", job: settled.job });
            } else if (settled.kind === "refused") {
              resolve({
                kind: "refused",
                message: settled.message,
                fieldErrors: settled.fieldErrors ?? {},
              });
            }
          }),
        );
        await changed();
      } while (again.current && result === "done");

      // A create that left the queue without this tab settling it was sent
      // by another tab: it exists, it isn't waiting.
      if (waiters.current.size > 0) {
        const left = new Set((await (await store()).list(id)).map((m) => m.id));
        for (const [mutationId, resolve] of waiters.current) {
          if (left.has(mutationId)) continue;
          resolve({ kind: "created", job: null });
          waiters.current.delete(mutationId);
        }
      }

      setReachable(result !== "offline");
      setProblem(null);
      if (result === "offline") {
        retryTimer.current = setTimeout(() => void flush(), RETRY_MS);
      }
    } catch (err) {
      setProblem(messageOf(err, "Could not send pending changes"));
    } finally {
      flushing.current = false;
      if (again.current) {
        // Triggered after the last pass had started: run once more.
        void flush();
      } else {
        // Whoever is still waiting: their change stays queued for later.
        for (const resolve of waiters.current.values()) {
          resolve({ kind: "queued" });
        }
        waiters.current.clear();
      }
    }
  }, [store, changed]);

  // Learn whose queue this is, then show and replay it.
  useEffect(() => {
    const adopt = (id: string) => {
      if (dispatcherId.current === id) return;
      dispatcherId.current = id;
      void reload();
      void flush();
    };
    const unsubscribe = onSessionChange((session) => {
      if (session) adopt(session.dispatcher.id);
    });
    // Offline at start-up the lookup fails; the session change above
    // catches the dispatcher once the token refreshes.
    getSession().then(
      (session) => session && adopt(session.dispatcher.id),
      () => {},
    );
    return unsubscribe;
  }, [reload, flush]);

  // Replay whenever the connection comes back.
  useEffect(() => {
    const onOnline = () => void flush();
    window.addEventListener("online", onOnline);
    socket?.on("connect", onOnline);
    return () => {
      window.removeEventListener("online", onOnline);
      socket?.off("connect", onOnline);
    };
  }, [socket, flush]);

  useEffect(() => {
    if (typeof BroadcastChannel === "undefined") return;
    const bc = new BroadcastChannel(CHANNEL);
    bc.onmessage = () => void reload();
    channel.current = bc;
    return () => {
      bc.close();
      channel.current = null;
      clearTimeout(retryTimer.current);
    };
  }, [reload]);

  const requireDispatcher = () => {
    const id = dispatcherId.current;
    if (!id) throw new Error("Still loading your session, try again");
    return id;
  };

  const enqueueEdit = useCallback(
    async (base: Job, edit: JobEdit) => {
      await (
        await store()
      ).add({
        id: crypto.randomUUID(),
        dispatcherId: requireDispatcher(),
        queuedAt: new Date().toISOString(),
        state: { kind: "pending" },
        kind: "edit",
        jobId: base.id,
        base,
        edit,
      });
      await changed();
      void flush();
    },
    [store, changed, flush],
  );

  const enqueueCreate = useCallback(
    async (input: CreateJobInput): Promise<CreateOutcome> => {
      const queued = await (
        await store()
      ).add({
        id: crypto.randomUUID(),
        dispatcherId: requireDispatcher(),
        queuedAt: new Date().toISOString(),
        state: { kind: "pending" },
        kind: "create",
        input,
      });
      const outcome = new Promise<CreateOutcome>((resolve) =>
        waiters.current.set(queued.id, resolve),
      );
      await changed();
      void flush();

      const result = await outcome;
      // The form shows a refusal next to the fields; don't list it twice.
      if (result.kind === "refused") {
        await (await store()).remove(queued);
        await changed();
      }
      return result;
    },
    [store, changed, flush],
  );

  /**
   * Replaces a queued change, but only if it is still stored as `mutation`
   * shows it: a second click on a prompt, or a prompt a replay has moved on
   * from, must not resurrect a change that was sent or resolved.
   */
  const replace = useCallback(
    async (mutation: QueuedMutation, next: QueuedMutation | null) => {
      const s = await store();
      const stored = (await s.list(mutation.dispatcherId)).find(
        (m) => m.seq === mutation.seq,
      );
      if (
        !stored ||
        JSON.stringify(stored.state) !== JSON.stringify(mutation.state)
      ) {
        return;
      }
      if (next) await s.put(next);
      else await s.remove(mutation);
      await changed();
      // Changes to the same job that waited behind it can go now.
      void flush();
    },
    [store, changed, flush],
  );

  const discard = useCallback(
    (mutation: QueuedMutation) => replace(mutation, null),
    [replace],
  );

  const applyOverLatest = useCallback(
    async (mutation: QueuedMutation) => {
      if (mutation.kind !== "edit" || mutation.state.kind !== "conflict") {
        return;
      }
      await replace(mutation, {
        ...mutation,
        base: mutation.state.latest,
        state: { kind: "pending" },
      });
    },
    [replace],
  );

  const retry = useCallback(
    (mutation: QueuedMutation) =>
      replace(mutation, { ...mutation, state: { kind: "pending" } }),
    [replace],
  );

  const subscribe = useCallback((listener: (job: Job) => void) => {
    listeners.current.add(listener);
    return () => void listeners.current.delete(listener);
  }, []);

  const value = useMemo(
    () => ({
      mutations,
      reachable,
      problem,
      enqueueEdit,
      enqueueCreate,
      discard,
      applyOverLatest,
      retry,
      subscribe,
    }),
    [
      mutations,
      reachable,
      problem,
      enqueueEdit,
      enqueueCreate,
      discard,
      applyOverLatest,
      retry,
      subscribe,
    ],
  );

  return <OutboxContext value={value}>{children}</OutboxContext>;
}
