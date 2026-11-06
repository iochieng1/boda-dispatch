import { ConnectionStatus } from "./connection-status";

export default function Home() {
  return (
    <main className="mx-auto max-w-3xl p-6">
      <h1 className="text-2xl font-semibold">Boda Dispatch</h1>
      <p className="mt-1 text-slate-600">
        Live delivery board for dispatchers and riders.
      </p>
      <ConnectionStatus />
    </main>
  );
}
