import { resolveE2ERun, verifyE2EServer } from "./e2e-run.mjs";

export default async function () {
  await verifyE2EServer(resolveE2ERun());
}
