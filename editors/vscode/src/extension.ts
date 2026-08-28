import * as vscode from "vscode";
import {
  LanguageClient,
  type LanguageClientOptions,
  type ServerOptions,
} from "vscode-languageclient/node";

let client: LanguageClient | undefined;

export async function activate(context: vscode.ExtensionContext): Promise<void> {
  const configuration = vscode.workspace.getConfiguration("polici");
  const command = configuration.get<string>("binary", "polici").trim() || "polici";
  const configuredArguments = configuration.get<unknown>("args", ["lsp", "--stdio"]);
  const args = Array.isArray(configuredArguments)
    ? configuredArguments.filter((value): value is string => typeof value === "string")
    : ["lsp", "--stdio"];

  const serverOptions: ServerOptions = { command, args };
  const lockfiles = vscode.workspace.createFileSystemWatcher("**/polici.lock{,.json}");
  const manifests = vscode.workspace.createFileSystemWatcher("**/{manifest.json,plugin.ts}");
  const clientOptions: LanguageClientOptions = {
    documentSelector: [{ scheme: "file", language: "polici" }],
    synchronize: {
      configurationSection: "polici",
      fileEvents: [lockfiles, manifests],
    },
    outputChannelName: "Polici Language Server",
  };

  client = new LanguageClient("polici", "Polici Language Server", serverOptions, clientOptions);
  context.subscriptions.push(lockfiles, manifests, client);
  await client.start();
}

export async function deactivate(): Promise<void> {
  const active = client;
  client = undefined;
  if (active !== undefined) await active.stop();
}
