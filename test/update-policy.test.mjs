import assert from "node:assert/strict";
import { createJiti } from "jiti";
const jiti = createJiti(import.meta.url);
const { checkLatestVersion, applyUpdate, installedVersion, PACKAGE_NAME } = await jiti.import("../selfupdate.ts");
let calls = 0;
const runner = async () => { calls++; throw new Error("An updater must not execute commands for this fork"); };
assert.equal(PACKAGE_NAME, "@spinachx64/pi-qqbot");
assert.match(installedVersion(), /^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/);
for (const result of [await checkLatestVersion(runner), await applyUpdate(runner)]) {
  assert.equal(result.ok, false);
  assert.match(result.error, /GitHub|github\.com/);
}
assert.equal(calls, 0, "Git-managed forks must not query or update upstream npm packages");
console.log("PASS Git-managed fork cannot execute npm self-update commands");
