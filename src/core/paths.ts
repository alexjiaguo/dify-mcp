import os from "node:os";
import path from "node:path";

/** Override with DIFYWF_HOME in tests and containers. */
export function difywfHome(): string {
  const override = process.env.DIFYWF_HOME;
  if (override && override.length > 0) return override;
  return path.join(os.homedir(), ".difywf");
}
