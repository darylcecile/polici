import { compilePolicy } from "../index.ts";
import { canonicalJson, RepositorySnapshot } from "../core/index.ts";
import {
  createLockedPlugin,
  pluginLockfileJson,
  pluginArtifactSha256,
  canonicalPluginManifestSha256,
  TypeScriptProcessResolverHost,
  WasiProcessResolverHost,
  wire,
  type PluginLockfile,
} from "../plugin/index.ts";
import type { PluginManifest } from "../plugin/manifest.js";
import { type as sdkType } from "../sdk/index.ts";

const manifest: PluginManifest = {
  schema: "polici.plugin/v2",
  schemaVersion: 2,
  name: "smoke",
  version: "1.0.0",
  policiApi: 1,
  contractMajor: 7,
  types: {},
  exports: {},
  permissions: [],
  runtime: {
    kind: "typescript",
    protocol: 1,
    entrypoint: "./smoke-runtime",
    transport: "jsonl",
    capabilities: [],
  },
};
const sdkBoolean = sdkType.boolean(undefined);
const artifact = new TextEncoder().encode("native-smoke-artifact");
const artifactDigest = pluginArtifactSha256(artifact);
const manifestDigest = canonicalPluginManifestSha256(manifest);
const locked = createLockedPlugin({
  source: { kind: "registry", locator: "smoke@1.0.0" },
  manifest,
  artifact,
});
const lockfile: PluginLockfile = {
  schema: "polici.lock/v2",
  schemaVersion: 2,
  plugins: [locked],
};
const compiled = compilePolicy(
  'using "smoke@7" as Smoke\npolicy "native" { rule "ok" { require true } }',
  { lockfile, lockedPlugins: [{ lock: locked, manifest, artifact }] },
);
const repository = new RepositorySnapshot();
const firstWire = wire.string("a");
const secondWire = wire.string("b");
const setWire = wire.set([firstWire, secondWire]);
const checkedWire = { ok: setWire.tag === "set" };
const native = new TypeScriptProcessResolverHost({
  cwd: "/",
  entrypoint: "./usr/bin/true",
  plugin: { name: "smoke", version: "1.0.0" },
  trustedRuntime: true,
});
const wasi = new WasiProcessResolverHost({
  cwd: "/",
  entrypoint: "./runtime.wasm",
  command: "/usr/bin/true",
  plugin: { name: "smoke", version: "1.0.0" },
});

console.log(
  JSON.stringify({
    diagnostics: compiled.diagnostics.length,
    files: repository.size,
    hashBytes: canonicalJson(manifest).length,
    lockBytes: pluginLockfileJson(lockfile).length,
    nativeCapabilities: native.capabilities.length,
    provider: manifest.name,
    sdk: sdkBoolean.kind,
    sha256: artifactDigest.value.length + manifestDigest.value.length,
    wasiCapabilities: wasi.capabilities.length,
    wire: checkedWire.ok,
  }),
);
