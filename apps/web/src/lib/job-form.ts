import {
  type CreateJobInput,
  createJobInputSchema,
} from "@boda-dispatch/shared";

export type JobFormResult =
  | { ok: true; input: CreateJobInput }
  /** Messages keyed by the field's dotted path, e.g. "pickup.address". */
  | { ok: false; errors: Record<string, string> };

const text = (form: FormData, name: string) => {
  const value = form.get(name);
  return typeof value === "string" ? value : "";
};

/** A blank box is "missing", not 0, which would be a valid coordinate. */
const coordinate = (form: FormData, name: string) => {
  const value = text(form, name).trim();
  return value === "" ? undefined : Number(value);
};

/** Reads the new-job form and validates it with the same schema as the API. */
export const parseJobForm = (form: FormData): JobFormResult => {
  const result = createJobInputSchema.safeParse({
    pickup: {
      address: text(form, "pickup.address"),
      lat: coordinate(form, "pickup.lat"),
      lng: coordinate(form, "pickup.lng"),
    },
    dropoff: {
      address: text(form, "dropoff.address"),
      lat: coordinate(form, "dropoff.lat"),
      lng: coordinate(form, "dropoff.lng"),
    },
    parcelDescription: text(form, "parcelDescription"),
  });
  if (result.success) return { ok: true, input: result.data };

  const errors: Record<string, string> = {};
  for (const issue of result.error.issues) {
    errors[issue.path.join(".")] ??= issue.message;
  }
  return { ok: false, errors };
};
