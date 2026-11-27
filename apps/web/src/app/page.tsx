import { ConnectionStatus } from "./connection-status";
import { JobBoard } from "./job-board";
import { NewJobForm } from "./new-job-form";
import { OfflineBanner } from "./offline-banner";
import { OutboxProvider } from "./outbox-provider";
import { SessionBar } from "./session-bar";
import { SocketProvider } from "./socket-provider";

export default function Home() {
  return (
    <SocketProvider>
      <OutboxProvider>
        <main className="mx-auto max-w-6xl p-6">
          <header className="flex items-start justify-between gap-4">
            <div>
              <h1 className="text-2xl font-semibold">Boda Dispatch</h1>
              <p className="mt-1 text-slate-600">
                Live delivery board for dispatchers and riders.
              </p>
            </div>
            <SessionBar />
          </header>
          <OfflineBanner />
          <ConnectionStatus />
          <JobBoard />
          <div className="max-w-3xl">
            <NewJobForm />
          </div>
        </main>
      </OutboxProvider>
    </SocketProvider>
  );
}
