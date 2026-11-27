"use client";

import { type FormEvent, useRef, useState } from "react";

import { parseJobForm } from "@/lib/job-form";

import { useOutbox } from "./outbox-provider";

const inputClass = "mt-1 w-full rounded border border-slate-300 px-3 py-2";

function Field({
  label,
  name,
  errors,
  ...props
}: {
  label: string;
  name: string;
  errors: Record<string, string>;
} & React.InputHTMLAttributes<HTMLInputElement>) {
  const error = errors[name];
  return (
    <label className="block">
      <span className="text-sm font-medium">{label}</span>
      <input
        name={name}
        aria-invalid={error ? true : undefined}
        className={inputClass}
        {...props}
      />
      {error && <span className="text-sm text-red-600">{error}</span>}
    </label>
  );
}

function Place({
  legend,
  prefix,
  errors,
}: {
  legend: string;
  prefix: "pickup" | "dropoff";
  errors: Record<string, string>;
}) {
  return (
    <fieldset className="space-y-3">
      <legend className="font-medium">{legend}</legend>
      <Field
        label="Address"
        name={`${prefix}.address`}
        errors={errors}
        autoComplete="off"
        placeholder="Kenyatta Ave, Nairobi"
      />
      <div className="grid grid-cols-2 gap-3">
        <Field
          label="Latitude"
          name={`${prefix}.lat`}
          errors={errors}
          type="number"
          step="any"
          inputMode="decimal"
          placeholder="-1.2864"
        />
        <Field
          label="Longitude"
          name={`${prefix}.lng`}
          errors={errors}
          type="number"
          step="any"
          inputMode="decimal"
          placeholder="36.8172"
        />
      </div>
    </fieldset>
  );
}

export function NewJobForm() {
  const { enqueueCreate } = useOutbox();
  const formRef = useRef<HTMLFormElement>(null);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [formError, setFormError] = useState<string | null>(null);
  const [created, setCreated] = useState<
    { kind: "created"; id: string } | { kind: "queued" } | null
  >(null);
  const [pending, setPending] = useState(false);

  const onSubmit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setCreated(null);
    setFormError(null);

    const parsed = parseJobForm(new FormData(event.currentTarget));
    if (!parsed.ok) return setErrors(parsed.errors);
    setErrors({});

    setPending(true);
    try {
      const outcome = await enqueueCreate(parsed.input);
      switch (outcome.kind) {
        case "created":
          setCreated({ kind: "created", id: outcome.job.id });
          formRef.current?.reset();
          break;
        case "queued":
          // Kept in the outbox; it is created when the connection returns.
          setCreated({ kind: "queued" });
          formRef.current?.reset();
          break;
        case "refused":
          setErrors(outcome.fieldErrors);
          setFormError(outcome.message);
      }
    } catch (err) {
      setFormError(
        err instanceof Error ? err.message : "Could not create the job",
      );
    } finally {
      setPending(false);
    }
  };

  return (
    <section className="mt-6 rounded-lg border border-slate-200 bg-white p-4">
      <h2 className="text-lg font-semibold">New delivery job</h2>
      <form
        ref={formRef}
        onSubmit={onSubmit}
        noValidate
        className="mt-4 space-y-5"
      >
        <Place legend="Pickup" prefix="pickup" errors={errors} />
        <Place legend="Drop-off" prefix="dropoff" errors={errors} />
        <Field
          label="Parcel"
          name="parcelDescription"
          errors={errors}
          autoComplete="off"
          placeholder="Envelope for the lawyer"
        />
        {formError && (
          <p role="alert" className="text-sm text-red-600">
            {formError}
          </p>
        )}
        {created?.kind === "created" && (
          <p role="status" className="text-sm text-emerald-700">
            Job created: <code>{created.id}</code>
          </p>
        )}
        {created?.kind === "queued" && (
          <p role="status" className="text-sm text-amber-700">
            Saved offline. The job will be created when the connection returns.
          </p>
        )}
        <button
          type="submit"
          disabled={pending}
          className="rounded bg-slate-900 px-4 py-2 font-medium text-white disabled:opacity-60"
        >
          {pending ? "Creating…" : "Create job"}
        </button>
      </form>
    </section>
  );
}
