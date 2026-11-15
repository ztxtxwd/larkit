#!/usr/bin/env node
import "../src/shared/quiet.js";
import process from "node:process";
import { checkAuth } from "../src/auth/service.js";
import {
  enableBotWs,
  getCredentials,
  grantScopes,
  listApps,
  publishVersion,
} from "../src/console/client.js";
import { probeOpenApi } from "../src/probe/openapi.js";

const profileArg = process.argv.find((arg) => arg.startsWith("--profile="));
const profile = profileArg ? profileArg.slice(10) : "geren";

const auth = await checkAuth({ profile });
console.log("auth:", auth.ok, auth.profile, auth.user?.name || auth.hint || auth.error);
if (!auth.ok) process.exit(1);

const apps = await listApps({ profile, limit: 30 });
console.log("apps:", apps.ok, apps.total);
if (!apps.ok || !apps.apps.length) process.exit(1);

const app =
  apps.apps.find((item) => item.status === 2 && item.abilities?.includes("bot")) ||
  apps.apps[0];
console.log("selected app:", app.app_id, app.name, "status=" + app.status);

const cred = await getCredentials({ appId: app.app_id, profile });
console.log("credentials:", cred.ok, "secret_len=" + (cred.app_secret?.length || 0));
if (!cred.ok) process.exit(1);

const probe = await probeOpenApi({
  appId: cred.app_id,
  appSecret: cred.app_secret,
  method: "GET",
  path: "/im/v1/chats",
  query: { page_size: 1 },
});
console.log("openapi probe:", probe.status, probe.code, probe.msg, probe.log_id || "");

const wsPlan = await enableBotWs({ appId: app.app_id, profile, dryRun: true });
console.log("bot ws dry-run:", wsPlan.ok, wsPlan.calls?.length || 0, "calls");

const scopePlan = await grantScopes({
  appId: app.app_id,
  scopes: ["im:message"],
  profile,
  dryRun: true,
});
console.log(
  "scope dry-run:",
  scopePlan.ok,
  "resolved=" + (scopePlan.plan?.resolved?.map((s) => s.name).join(",") || ""),
  "missing=" + (scopePlan.plan?.missing?.join(",") || ""),
);

const publishPlan = await publishVersion({ appId: app.app_id, profile, dryRun: true });
console.log("publish dry-run:", publishPlan.ok, publishPlan.plan?.steps?.length || 0, "steps");
