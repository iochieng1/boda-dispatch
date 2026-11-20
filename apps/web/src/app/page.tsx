import { ConnectionStatus } from "./connection-status";
import { SessionBar } from "./session-bar";

export default function Home() {
  return (
    <main className="mx-auto max-w-3xl p-6">
      <header className="flex items-start justify-between gap-4">
        <div>
          <h1 className="text-2xl font-semibold">Boda Dispatch</h1>
          <p className="mt-1 text-slate-600">
            Live delivery board for dispatchers and riders.
          </p>
        </div>
        <SessionBar />
      </header>
      <ConnectionStatus />
    </main>
  );
}
