"use client";

import type { DispatcherProfile } from "@boda-dispatch/shared";
import { useEffect, useState } from "react";

import { getSession, logout, onSessionChange } from "@/lib/session";

export function SessionBar() {
  const [dispatcher, setDispatcher] = useState<DispatcherProfile | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    getSession().then(
      (session) => setDispatcher(session?.dispatcher ?? null),
      () => undefined,
    );
    return onSessionChange((session) =>
      setDispatcher(session?.dispatcher ?? null),
    );
  }, []);

  const signOut = async () => {
    setError(null);
    try {
      await logout();
    } catch {
      setError("Sign-out failed. Check your connection and try again.");
      return;
    }
    window.location.assign("/login");
  };

  return (
    <div className="flex items-center gap-3 text-sm">
      {dispatcher && (
        <span className="text-slate-600">
          Signed in as <span className="font-medium">{dispatcher.name}</span>
        </span>
      )}
      <button
        type="button"
        onClick={() => void signOut()}
        className="rounded border border-slate-300 px-2 py-1 hover:bg-slate-100"
      >
        Sign out
      </button>
      {error && (
        <p role="alert" className="text-red-600">
          {error}
        </p>
      )}
    </div>
  );
}
