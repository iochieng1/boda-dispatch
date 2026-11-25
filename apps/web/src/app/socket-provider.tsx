"use client";

import {
  type ClientToServerEvents,
  type ServerHello,
  type ServerToClientEvents,
  serverHelloSchema,
  SOCKET_UNAUTHORIZED,
  type SocketAuthRefreshAck,
} from "@boda-dispatch/shared";
import {
  createContext,
  type ReactNode,
  useContext,
  useEffect,
  useState,
} from "react";
import { io, type Socket } from "socket.io-client";

import {
  getSession,
  onSessionChange,
  REFRESH_LEAD_MS,
  redirectToLogin,
  refreshSession,
} from "@/lib/session";

export type ConnectionState =
  "connecting" | "connected" | "reconnecting" | "disconnected";
type Status = ConnectionState;

export type DispatchSocket = Socket<ServerToClientEvents, ClientToServerEvents>;

export const SERVER_URL =
  process.env.NEXT_PUBLIC_SERVER_URL ?? "http://localhost:4000";

// If a refresh fails for a transient reason (network), try again after this.
const RETRY_MS = 10_000;
// Handshake refusals in a row before giving up (a fresh token that is still
// refused, e.g. clock skew, would otherwise loop forever).
const MAX_AUTH_RETRIES = 2;
// auth:refresh pushes that get no ack are retried this often, this many
// times: 5 x (5s timeout + 3s) fits inside the 60s refresh lead.
const PUSH_RETRY_MS = 3_000;
const MAX_PUSH_ATTEMPTS = 5;

type Connection = {
  /** The one socket for this page; null until the provider has created it. */
  socket: DispatchSocket | null;
  status: Status;
  hello: ServerHello | null;
};

const ConnectionContext = createContext<Connection>({
  socket: null,
  status: "connecting",
  hello: null,
});

export const useConnection = () => useContext(ConnectionContext);

/**
 * Owns the dashboard's socket: connects with the session's token, keeps the
 * token fresh, and reconnects. Components read the socket and its status
 * through useConnection and subscribe to the events they care about.
 */
export function SocketProvider({ children }: { children: ReactNode }) {
  const [status, setStatus] = useState<Status>("connecting");
  const [hello, setHello] = useState<ServerHello | null>(null);
  const [socket, setSocket] = useState<DispatchSocket | null>(null);

  useEffect(() => {
    let refreshTimer: ReturnType<typeof setTimeout> | undefined;
    let stopped = false;
    let authRetries = 0;

    const socket: DispatchSocket = io(SERVER_URL, {
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
    });

    setSocket(socket);

    /** Gets a new token and, if needed, a new socket connection. */
    const recover = async () => {
      if (stopped) return;
      try {
        const session = await refreshSession();
        if (!session) return redirectToLogin();
        if (!socket.connected && !stopped) socket.connect();
      } catch {
        // Network error or API down: keep trying until it comes back.
        setStatus("reconnecting");
        clearTimeout(refreshTimer);
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

    let latestToken: string | null = null;

    /** Hands a token to the live socket, retrying if the ack is lost. */
    const pushToken = (token: string, attempt = 1) => {
      if (stopped || !socket.connected || token !== latestToken) return;
      socket
        .timeout(5_000)
        .emitWithAck("auth:refresh", { token })
        .then(
          (ack: SocketAuthRefreshAck) => {
            // Rejected: reconnect so the handshake checks the token afresh.
            if (!ack.ok) socket.disconnect().connect();
          },
          () => {
            // No ack in time. The server still holds the old token, which
            // expires within a minute, so retry now rather than at the next
            // scheduled refresh ~14 minutes away.
            if (attempt < MAX_PUSH_ATTEMPTS) {
              setTimeout(() => pushToken(token, attempt + 1), PUSH_RETRY_MS);
            }
          },
        );
    };

    // Each new access token (from our timer, or any other caller) is handed
    // to the live socket: same socket id and rooms, no reconnect.
    const unsubscribe = onSessionChange((session) => {
      if (!session) return redirectToLogin();
      latestToken = session.accessToken;
      scheduleRefresh(session.expiresAt);
      pushToken(session.accessToken);
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
      () => {
        // The API was unreachable on load (e.g. mid-deploy): retry rather
        // than staying offline until a manual reload.
        setStatus("reconnecting");
        refreshTimer = setTimeout(() => void recover(), RETRY_MS);
      },
    );

    return () => {
      stopped = true;
      clearTimeout(refreshTimer);
      unsubscribe();
      socket.disconnect();
      setSocket(null);
    };
  }, []);

  return (
    <ConnectionContext value={{ socket, status, hello }}>
      {children}
    </ConnectionContext>
  );
}
