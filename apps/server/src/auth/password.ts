import { hash, verify } from "@node-rs/argon2";

// argon2id is the library default (the `Algorithm` const enum can't be used
// with verbatimModuleSyntax). OWASP-recommended parameters: 19 MiB, 2
// iterations, 1 lane. Tests assert the stored hash starts with $argon2id$.
const options = {
  memoryCost: 19_456,
  timeCost: 2,
  parallelism: 1,
};

/**
 * Each hash takes 19 MiB, so at most this many run at once; the rest queue.
 * This bounds memory under a burst of logins (the rate limiter bounds the
 * burst itself).
 */
const MAX_CONCURRENT_HASHES = 4;
let running = 0;
const waiting: Array<() => void> = [];

const limited = async <T>(fn: () => Promise<T>): Promise<T> => {
  if (running >= MAX_CONCURRENT_HASHES) {
    await new Promise<void>((resolve) => waiting.push(resolve));
  } else {
    running++;
  }
  try {
    return await fn();
  } finally {
    // Hand the slot straight to the next waiter, or free it.
    const next = waiting.shift();
    if (next) next();
    else running--;
  }
};

export const hashPassword = (password: string) =>
  limited(() => hash(password, options));

export const verifyPassword = (passwordHash: string, password: string) =>
  limited(() => verify(passwordHash, password));

let dummyHash: Promise<string> | undefined;

/**
 * Computes the throwaway hash up front (called at start-up), so the first
 * unknown-email login doesn't pay for an extra hash and stand out by timing.
 */
export const prepareDummyHash = () =>
  (dummyHash ??= hashPassword("boda-dispatch-dummy-password"));

/**
 * Runs a full argon2 verification against a throwaway hash. Login calls this
 * when the email is unknown, so the response takes as long as a wrong password
 * and timing doesn't reveal which emails belong to dispatchers.
 */
export const verifyAgainstDummyHash = async (password: string) => {
  const target = await prepareDummyHash();
  await limited(() => verify(target, password));
  return false;
};
