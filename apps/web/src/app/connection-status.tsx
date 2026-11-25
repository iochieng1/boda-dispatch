"use client";

import {
  type ConnectionState,
  SERVER_URL,
  useConnection,
} from "./socket-provider";

const styles: Record<ConnectionState, string> = {
  connecting: "bg-slate-400",
  connected: "bg-emerald-500",
  reconnecting: "bg-amber-500 animate-pulse",
  disconnected: "bg-red-500",
};

export function ConnectionStatus() {
  const { status, hello } = useConnection();

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
