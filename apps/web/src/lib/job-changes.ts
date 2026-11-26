import {
  type Job,
  type JobConflict,
  type JobEdit,
  type JobEditField,
  rebaseJobEdit,
} from "@boda-dispatch/shared";

/** What the server said to one attempt at a change. */
export type SendResult =
  { kind: "ok"; job: Job } | { kind: "conflict"; conflict: JobConflict };

/** Sends `edit` based on `baseVersion`; throws on anything but 200 or 409. */
export type SendChange = (
  edit: JobEdit,
  baseVersion: number,
) => Promise<SendResult>;

export type SaveResult =
  /** Saved, possibly after rebasing onto someone else's change. */
  | { kind: "saved"; job: Job }
  /**
   * Someone else changed the same fields differently. `latest` is the job as
   * it is now; ask the dispatcher whether to keep it or apply `edit` over it.
   */
  | { kind: "conflict"; latest: Job; edit: JobEdit; fields: JobEditField[] }
  /** The server refused the change for a reason a rebase can't fix. */
  | { kind: "refused"; latest: Job; message: string };

/** Enough for a busy job; past this, something is wrong and a person should look. */
export const MAX_REBASES = 3;

/**
 * Sends an edit made against `base`. If the job changed meanwhile (409
 * VERSION_CONFLICT), the edit is rebased onto the job the server sent back
 * and retried: automatically when nobody else touched the same fields, and
 * not at all when someone did, so the dispatcher decides.
 */
export const saveJobEdit = async (
  base: Job,
  edit: JobEdit,
  send: SendChange,
): Promise<SaveResult> => {
  let current = base;
  let pending = edit;

  for (let attempt = 0; ; attempt++) {
    const result = await send(pending, current.version);
    if (result.kind === "ok") return { kind: "saved", job: result.job };

    const { code, message, job: latest } = result.conflict;
    if (code !== "VERSION_CONFLICT" || attempt >= MAX_REBASES) {
      return { kind: "refused", latest, message };
    }

    const rebased = rebaseJobEdit(current, latest, pending);
    switch (rebased.kind) {
      case "unchanged":
        return { kind: "saved", job: latest };
      case "conflict":
        return {
          kind: "conflict",
          latest,
          edit: pending,
          fields: rebased.fields,
        };
      case "rebased":
        current = latest;
        pending = rebased.edit;
    }
  }
};
