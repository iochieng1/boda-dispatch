import type { Job, JobEdit, Location } from "./jobs.js";

/**
 * The parts of a job an edit can touch. Status and rider move together: the
 * rider only means something alongside ASSIGNED, so they are one field here.
 */
export type JobEditField =
  "pickup" | "dropoff" | "parcelDescription" | "status";

export type RebaseResult =
  /** Reapply `edit` on top of the latest job, based on its version. */
  | { kind: "rebased"; edit: JobEdit; baseVersion: number }
  /** The latest job already has everything the edit asked for. */
  | { kind: "unchanged" }
  /** Someone else changed these fields differently; a person must choose. */
  | { kind: "conflict"; fields: JobEditField[] };

const sameLocation = (a: Location, b: Location) =>
  a.address === b.address && a.lat === b.lat && a.lng === b.lng;

const same = {
  pickup: (a: Job, b: Job) => sameLocation(a.pickup, b.pickup),
  dropoff: (a: Job, b: Job) => sameLocation(a.dropoff, b.dropoff),
  parcelDescription: (a: Job, b: Job) =>
    a.parcelDescription === b.parcelDescription,
  status: (a: Job, b: Job) =>
    a.status === b.status && a.assignedRiderId === b.assignedRiderId,
};

/** Whether `job` already has the value the edit sets for `field`. */
const hasEdit = (job: Job, edit: JobEdit, field: JobEditField): boolean => {
  switch (field) {
    case "pickup":
      return sameLocation(job.pickup, edit.pickup!);
    case "dropoff":
      return sameLocation(job.dropoff, edit.dropoff!);
    case "parcelDescription":
      return job.parcelDescription === edit.parcelDescription;
    case "status":
      return (
        job.status === edit.status &&
        (edit.assignedRiderId === undefined ||
          job.assignedRiderId === edit.assignedRiderId)
      );
  }
};

const FIELDS: JobEditField[] = [
  "pickup",
  "dropoff",
  "parcelDescription",
  "status",
];

/**
 * Rebases an edit made against `base` onto `latest`, after the server refused
 * it with a VERSION_CONFLICT. A three-way merge per field:
 *
 * - Nobody else touched the field: keep the edit.
 * - Someone else already made the same change: drop it, there's nothing to do.
 * - Someone else changed it to something different: a conflict. "Both changed
 *   the assigned rider" has no right automatic answer, so it goes to a person.
 *
 * Fields the edit doesn't touch never conflict: the edit is reapplied on top
 * of whatever else changed. The server still checks the result (a job that
 * was closed meanwhile is refused with JOB_CLOSED, for example).
 */
export const rebaseJobEdit = (
  base: Job,
  latest: Job,
  edit: JobEdit,
): RebaseResult => {
  const touched = FIELDS.filter((field) => edit[field] !== undefined);
  const conflicts: JobEditField[] = [];
  const rebased: JobEdit = {};

  for (const field of touched) {
    if (hasEdit(latest, edit, field)) continue;
    if (!same[field](base, latest)) {
      conflicts.push(field);
      continue;
    }
    if (field === "status") {
      rebased.status = edit.status;
      if (edit.assignedRiderId) rebased.assignedRiderId = edit.assignedRiderId;
    } else {
      Object.assign(rebased, { [field]: edit[field] });
    }
  }

  if (conflicts.length > 0) return { kind: "conflict", fields: conflicts };
  if (Object.keys(rebased).length === 0) return { kind: "unchanged" };
  return { kind: "rebased", edit: rebased, baseVersion: latest.version };
};
