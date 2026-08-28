import { compilePolicy } from "./compile.ts";
import { evaluatePolicy } from "./evaluate.ts";
import type { CheckPolicyOptions, PolicyCheckResult } from "./types.ts";

export { compilePolicy, parsePolicy } from "./compile.ts";
export { evaluatePolicy } from "./evaluate.ts";
export { adaptPluginManifest } from "./manifest.ts";
export type * from "./types.ts";

export async function checkPolicy(
  source: string,
  options: CheckPolicyOptions,
): Promise<PolicyCheckResult> {
  const compiled = compilePolicy(source, options);
  return evaluatePolicy(compiled, options);
}
