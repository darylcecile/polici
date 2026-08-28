// @ts-ignore This bare repository has no @types/node; ScriptC provides its own built-in types.
import { createHash } from "node:crypto";

/** Keep this composed chain intact: ScriptC lowers it as one fused call. */
export function sha256(data: string): string {
  return createHash("sha256").update(data).digest("hex");
}

/** Byte-input counterpart with the same ScriptC-compatible fused call shape. */
export function sha256Bytes(data: Uint8Array): string {
  return createHash("sha256").update(data).digest("hex");
}
