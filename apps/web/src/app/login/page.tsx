import type { Metadata } from "next";

import { safeNextPath } from "@/lib/auth-shared";

import { LoginForm } from "./login-form";

export const metadata: Metadata = { title: "Sign in · Boda Dispatch" };

export default async function LoginPage({
  searchParams,
}: {
  searchParams: Promise<{ next?: string | string[] }>;
}) {
  const { next } = await searchParams;

  return (
    <main className="mx-auto flex min-h-screen max-w-sm flex-col justify-center p-6">
      <h1 className="text-2xl font-semibold">Boda Dispatch</h1>
      <p className="mt-1 text-slate-600">
        Sign in to the dispatcher dashboard.
      </p>
      <LoginForm next={safeNextPath(next)} />
    </main>
  );
}
