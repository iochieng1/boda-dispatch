"use client";

import {
  type ClientToServerEvents,
  type ServerHello,
  type ServerToClientEvents,
  serverHelloSchema,
} from "@boda-dispatch/shared";
import { useEffect, useState } from "react";
import { io, type Socket } from "socket.io-client";

type Status = "connecting" | "connected" | "reconnecting" | "disconnected";

const SERVER_URL =
  process.env.NEXT_PUBLIC_SERVER_URL ?? "http://localhost:4000";

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
    const socket: Socket<ServerToClientEvents, ClientToServerEvents> =
      io(SERVER_URL);

    socket.on("connect", () => setStatus("connected"));
    socket.on("disconnect", () =>
      // socket.active is true while the client will try to reconnect itself.
      setStatus(socket.active ? "reconnecting" : "disconnected"),
    );
    socket.on("connect_error", () =>
      setStatus(socket.active ? "reconnecting" : "disconnected"),
    );
    socket.io.on("reconnect_attempt", () => setStatus("reconnecting"));
    socket.io.on("reconnect_failed", () => setStatus("disconnected"));
    socket.on("server:hello", (payload) => {
      const parsed = serverHelloSchema.safeParse(payload);
      if (parsed.success) setHello(parsed.data);
    });

    return () => {
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
