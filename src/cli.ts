#!/usr/bin/env bun
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { MaintrailApp } from "./app.ts";
import { seedDemo } from "./demo.ts";
import { installLaunchAgent, uninstallLaunchAgent } from "./launchd.ts";
import { Logger } from "./logger.ts";
import { InstanceLock, StateStore } from "./state.ts";
import { TreeRuntime } from "./tree.ts";
import { stateDirectory } from "./utils.ts";
import { TranscriptWatcher } from "./watcher.ts";

const VERSION = typeof __MAINTRAIL_VERSION__ === "string" ? __MAINTRAIL_VERSION__ : "0.1.0-dev";

type Parsed = {
  command: string;
  stateDirectory: string;
  port?: number;
  open: boolean;
  watch: boolean;
};

function parse(argv: string[]): Parsed {
  let command = argv[0] && !argv[0].startsWith("-") ? argv[0] : "serve";
  let directory: string | undefined;
  let port: number | undefined;
  let open = true;
  let watch = true;
  for (let index = command === "serve" && argv[0]?.startsWith("-") ? 0 : 1; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--state-dir") directory = argv[++index];
    else if (arg === "--port") port = Number(argv[++index]);
    else if (arg === "--no-open") open = false;
    else if (arg === "--no-watch") watch = false;
    else if (arg === "--help" || arg === "-h") command = "help";
    else if (arg === "--version" || arg === "-v") command = "version";
    else throw new Error(`unknown argument: ${arg}`);
  }
  if (port !== undefined && (!Number.isInteger(port) || port < 0 || port > 65_535)) throw new Error("port must be 0-65535");
  return {
    command,
    stateDirectory: stateDirectory(directory),
    ...(port !== undefined ? { port } : {}),
    open,
    watch,
  };
}

function help(): void {
  console.log(`Maintrail ${VERSION} — persistent thinking map for parallel coding agents

Usage:
  maintrail serve [--port 4317] [--state-dir PATH] [--no-open] [--no-watch]
  maintrail once [--state-dir PATH]
  maintrail demo [--state-dir PATH]
  maintrail install [--state-dir PATH]
  maintrail uninstall
  maintrail status [--state-dir PATH]

State defaults to ~/.maintrail. The HTTP service binds only to 127.0.0.1.`);
}

async function openBrowser(url: string): Promise<void> {
  if (process.platform !== "darwin") return;
  const proc = Bun.spawn(["/usr/bin/open", url], { stdin: "ignore", stdout: "ignore", stderr: "ignore" });
  await proc.exited;
}

async function serve(options: Parsed): Promise<void> {
  const app = new MaintrailApp({
    stateDirectory: options.stateDirectory,
    watch: options.watch,
    ...(options.port !== undefined ? { port: options.port } : {}),
  });
  app.start();
  console.log(`Maintrail is available at ${app.http.url}`);
  if (options.open) void openBrowser(app.http.url);
  await new Promise<void>((resolve) => {
    const close = (): void => {
      app.stop();
      resolve();
    };
    process.once("SIGINT", close);
    process.once("SIGTERM", close);
  });
}

async function once(options: Parsed): Promise<void> {
  const logger = new Logger(join(options.stateDirectory, "server.log"));
  const lock = new InstanceLock(options.stateDirectory);
  lock.acquire();
  try {
    const store = new StateStore(options.stateDirectory, logger);
    const runtime = new TreeRuntime(store);
    const watcher = new TranscriptWatcher(store, runtime, process.cwd(), logger);
    await watcher.once();
    console.log(`Consumed pending transcripts; state revision ${store.snapshot().revision}.`);
  } finally {
    lock.release();
  }
}

async function demo(options: Parsed): Promise<void> {
  const explicit = process.argv.includes("--state-dir") || Boolean(process.env.MAINTRAIL_STATE_DIR);
  const directory = explicit ? options.stateDirectory : join(homedir(), ".maintrail-demo");
  const lock = new InstanceLock(directory);
  lock.acquire();
  try {
    const store = new StateStore(directory);
    await seedDemo(store, new TreeRuntime(store));
  } finally {
    lock.release();
  }
  console.log(`Demo state written to ${directory}`);
  console.log(`Run: maintrail serve --state-dir ${JSON.stringify(directory)} --no-watch`);
}

async function status(options: Parsed): Promise<void> {
  if (!existsSync(join(options.stateDirectory, "state.json"))) {
    console.log("Maintrail has no state yet.");
    return;
  }
  const state = new StateStore(options.stateDirectory).snapshot();
  console.log(JSON.stringify({
    revision: state.revision,
    mainlines: state.roots.length,
    archived: state.archived.length,
    sessions: Object.keys(state.sessions).length,
    engine: state.engine,
    updatedAt: state.updatedAt,
  }, null, 2));
}

async function main(): Promise<void> {
  const options = parse(process.argv.slice(2));
  if (options.command === "help") help();
  else if (options.command === "version") console.log(VERSION);
  else if (options.command === "serve") await serve(options);
  else if (options.command === "once") await once(options);
  else if (options.command === "demo") await demo(options);
  else if (options.command === "install") console.log(`Installed ${await installLaunchAgent(options.stateDirectory)}`);
  else if (options.command === "uninstall") console.log(await uninstallLaunchAgent() ? "Uninstalled Maintrail." : "Maintrail was not installed.");
  else if (options.command === "status") await status(options);
  else throw new Error(`unknown command: ${options.command}`);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});

declare const __MAINTRAIL_VERSION__: string;
