#!/usr/bin/env node
import {
  FileCredentialStore,
  credentialPath,
  loginAndSave,
  terminalInteraction,
} from "../lib/index.js";
import { AccountPoolManager, accountsPoolPath } from "../lib/pool.js";

const controller = new AbortController();
const args = new Set(process.argv.slice(2));
const logout = args.has("--logout");

for (const signalName of ["SIGINT", "SIGTERM"]) {
  process.once(signalName, () => {
    controller.abort(new Error(`${signalName} received`));
  });
}

try {
  const store = new FileCredentialStore(credentialPath());
  const pool = new AccountPoolManager();
  if (logout) {
    await pool.init();
    for (const account of [...pool.allAccounts]) await pool.removeAccount(account.id);
    await store.delete();
    console.log(`Removed Antigravity pool and legacy credentials`);
    process.exit(0);
  }
  const credentials = await loginAndSave(pool, terminalInteraction(controller.signal));
  const suffix = credentials.email ? ` for ${credentials.email}` : "";
  console.log(`Antigravity login complete${suffix}.`);
  console.log(`Credentials saved to ${accountsPoolPath()}`);
} catch (error) {
  const detail = error instanceof Error ? error.message : String(error);
  console.error(`Antigravity login failed: ${detail}`);
  process.exitCode = 1;
}
