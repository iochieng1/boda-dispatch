import { createInterface } from "node:readline/promises";
import { parseArgs } from "node:util";

import { hashPassword } from "../auth/password.js";
import { loadConfig } from "../config.js";
import { createDb } from "../db/client.js";
import { dispatchers } from "../db/schema.js";

/**
 * Creates a dispatcher account. There's no public sign-up: dispatchers are
 * staff, so accounts are provisioned by whoever runs the server.
 *
 *   npm run dispatcher:create -w @boda-dispatch/server -- \
 *     --email jane@boda.example --name "Jane Wanjiru"
 *
 * The password is read from DISPATCHER_PASSWORD or prompted for, so it never
 * lands in shell history.
 */
const { values } = parseArgs({
  options: {
    email: { type: "string" },
    name: { type: "string" },
  },
});

if (!values.email || !values.name) {
  console.error("Usage: dispatcher:create --email <email> --name <name>");
  process.exit(1);
}

let password = process.env.DISPATCHER_PASSWORD;
if (!password) {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  password = await rl.question("Password (8+ characters): ");
  rl.close();
}

if (password.length < 8 || password.length > 128) {
  console.error("Password must be 8-128 characters");
  process.exit(1);
}

const { db, sql } = createDb(loadConfig().DATABASE_URL);
try {
  const [dispatcher] = await db
    .insert(dispatchers)
    .values({
      email: values.email.trim().toLowerCase(),
      name: values.name.trim(),
      passwordHash: await hashPassword(password),
    })
    .returning({ id: dispatchers.id, email: dispatchers.email });
  console.log(`Created dispatcher ${dispatcher!.email} (${dispatcher!.id})`);
} finally {
  await sql.end();
}
