"use client";

import {
  type ClientToServerEvents,
  type ServerHello,
  type ServerToClientEvents,
  serverHelloSchema,
  SOCKET_UNAUTHORIZED,
  type SocketAuthRefreshAck,
} from "@boda-dispatch/shared";
import { useEffect, useState } from "react";
import { io, type Socket } from "socket.io-client";

import {
  getSession,
  onSessionChange,
  REFRESH_LEAD_MS,
  redirectToLogin,
  refreshSession,
} from "@/lib/session";

type Status = "connecting" | "connected" | "reconnecting" | "disconnected";

const SERVER_URL =
  process.env.NEXT_PUBLIC_SERVER_URL ?? "http://localhost:4000";

// If a refresh fails for a transient reason (network), try again after this.
const RETRY_MS = 10_000;
// Handshake refusals in a row before giving up (a fresh token that is still
// refused, e.g. clock skew, would otherwise loop forever).
const MAX_AUTH_RETRIES = 2;

const styles: Record<Status, string> = {
  connecting: "bg-slate-400",
  connected: "bg-emerald-500",
  reconnecting: "bg-amber-500 animate-pulse",
  disconnected: "bg-red-500",
};

export function ConnectionStatus() {
  const [status, setStatus] = useState<Status>("connecting");
  const [hello, setHello] = useState<ServerHello | null>(null);

  useEffect(() => {
    let refreshTimer: ReturnType<typeof setTimeout> | undefined;
    let stopped = false;
    let authRetries = 0;

    const socket: Socket<ServerToClientEvents, ClientToServerEvents> = io(
      SERVER_URL,
      {
        autoConnect: false,
        // Called on every connect and reconnect, so a reconnect after a
        // network drop always presents the current (or a refreshed) token.
        auth: (cb) => {
          getSession().then(
            (session) =>
              session ? cb({ token: session.accessToken }) : redirectToLogin(),
            () => cb({ token: "" }),
          );
        },
      },
    );

    /** Gets a new token and, if needed, a new socket connection. */
    const recover = async () => {
      try {
        const session = await refreshSession();
        if (!session) return redirectToLogin();
        if (!socket.connected && !stopped) socket.connect();
      } catch {
        refreshTimer = setTimeout(() => void recover(), RETRY_MS);
      }
    };

    const scheduleRefresh = (expiresAt: number) => {
      clearTimeout(refreshTimer);
      refreshTimer = setTimeout(
        () => void recover(),
        Math.max(0, expiresAt - Date.now() - REFRESH_LEAD_MS),
      );
    };

    // Each new access token (from our timer, or any other caller) is handed
    // to the live socket: same socket id and rooms, no reconnect.
    const unsubscribe = onSessionChange((session) => {
      if (!session) return redirectToLogin();
      scheduleRefresh(session.expiresAt);
      if (!socket.connected) return;
      socket
        .timeout(5_000)
        .emitWithAck("auth:refresh", { token: session.accessToken })
        .then(
          (ack: SocketAuthRefreshAck) => {
            // Rejected: reconnect so the handshake checks the token afresh.
            if (!ack.ok) socket.disconnect().connect();
          },
          () => undefined, // No ack in time: the next refresh will retry.
        );
    });

    socket.on("connect", () => {
      authRetries = 0;
      setStatus("connected");
    });
    socket.on("disconnect", (reason) => {
      // socket.active is true while the client will try to reconnect itself.
      setStatus(socket.active ? "reconnecting" : "disconnected");
      // The server dropped us (token expired before we refreshed it, e.g. a
      // laptop that slept): refresh and reconnect.
      if (reason === "io server disconnect" && !stopped) {
        setStatus("reconnecting");
        void recover();
      }
    });
    socket.on("connect_error", (err) => {
      setStatus(socket.active ? "reconnecting" : "disconnected");
      // Handshake refused: our token was rejected. Refresh once and retry.
      if (
        err.message === SOCKET_UNAUTHORIZED &&
        !stopped &&
        authRetries++ < MAX_AUTH_RETRIES
      ) {
        setStatus("reconnecting");
        void recover();
      }
    });
    socket.io.on("reconnect_attempt", () => setStatus("reconnecting"));
    socket.io.on("reconnect_failed", () => setStatus("disconnected"));
    socket.on("server:hello", (payload) => {
      const parsed = serverHelloSchema.safeParse(payload);
      if (parsed.success) setHello(parsed.data);
    });

    getSession().then(
      (session) => {
        if (stopped) return;
        if (!session) return redirectToLogin();
        scheduleRefresh(session.expiresAt);
        socket.connect();
      },
      () => setStatus("disconnected"),
    );

    return () => {
      stopped = true;
      clearTimeout(refreshTimer);
      unsubscribe();
      socket.disconnect();
    };
  }, []);

  return (
    <section className="mt-6 rounded-lg border border-slate-200 bg-white p-4">
      <div className="flex items-center gap-2" role="status" aria-live="polite">
        <span className={`h-3 w-3 rounded-full ${styles[status]}`} />
        <span className="font-medium capitalize">{status}</span>
        <span className="text-sm text-slate-500">to {SERVER_URL}</span>
      </div>
      {hello && (
        <p className="mt-2 text-sm text-slate-600">
          Server says hello to socket <code>{hello.socketId}</code> at{" "}
          {new Date(hello.serverTime).toLocaleTimeString()}
        </p>
      )}
    </section>
  );
}
