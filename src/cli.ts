#!/usr/bin/env bun
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { SessionMapApp } from "./app.ts";
import { DEFAULT_PORT } from "./constants.ts";
import { seedDemo } from "./demo.ts";
import { installLaunchAgent, uninstallLaunchAgent } from "./launchd.ts";
import { Logger } from "./logger.ts";
import { openSessionMap } from "./open.ts";
import { ensureCapabilityToken } from "./server.ts";
import { InstanceLock, StateStore } from "./state.ts";
import { TreeRuntime } from "./tree.ts";
import { defaultStateDirectory, stateDirectory } from "./utils.ts";
import { TranscriptWatcher } from "./watcher.ts";

const VERSION = typeof __SESSIONMAP_VERSION__ === "string" ? __SESSIONMAP_VERSION__ : "0.1.0-dev";

type Parsed = {
  command: string;
  stateDirectory: string;
  port?: number;
  open: boolean;
  watch: boolean;
  browser?: string;
};

function parse(argv: string[]): Parsed {
  let command = argv[0] && !argv[0].startsWith("-") ? argv[0] : "serve";
  let directory: string | undefined;
  let port: number | undefined;
  let open = true;
  let watch = true;
  let browser: string | undefined;
  for (let index = command === "serve" && argv[0]?.startsWith("-") ? 0 : 1; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--state-dir") directory = argv[++index];
    else if (arg === "--port") port = Number(argv[++index]);
    else if (arg === "--no-open") open = false;
    else if (arg === "--no-watch") watch = false;
    else if (arg === "--browser") {
      const value = argv[++index];
      if (!value || value.length > 200 || /[\u0000-\u001f]/.test(value)) throw new Error("browser must name a macOS application");
      browser = value;
    }
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
    ...(browser ? { browser } : {}),
  };
}

function help(): void {
  console.log(`SessionMap ${VERSION} — persistent thinking map for parallel coding agents

Usage:
  sessionmap serve [--port 4317] [--state-dir PATH] [--no-open] [--no-watch] [--browser APP]
  sessionmap open [--port 4317] [--state-dir PATH] [--browser APP]
  sessionmap once [--state-dir PATH]
  sessionmap demo [--state-dir PATH]
  sessionmap install [--state-dir PATH]
  sessionmap uninstall
  sessionmap status [--state-dir PATH]

State defaults to ~/Library/Application Support/SessionMap. The HTTP service binds only to 127.0.0.1.
Browser aliases: chrome, safari, firefox, edge, brave, arc. Any installed macOS application name is accepted.`);
}

async function serve(options: Parsed): Promise<void> {
  const app = new SessionMapApp({
    stateDirectory: options.stateDirectory,
    watch: options.watch,
    ...(options.port !== undefined ? { port: options.port } : {}),
  });
  app.start();
  console.log(`SessionMap is available at ${app.http.url}`);
  const closing = new Promise<void>((resolve) => {
    const close = (): void => {
      app.stop();
      resolve();
    };
    process.once("SIGINT", close);
    process.once("SIGTERM", close);
  });
  if (options.open) {
    void openSessionMap({ baseUrl: app.http.url, token: app.http.token, ...(options.browser ? { browser: options.browser } : {}) })
      .then(() => console.log("SessionMap is visible in the browser."))
      .catch((error) => console.error(error instanceof Error ? error.message : String(error)));
  }
  await closing;
}

async function openInstalled(options: Parsed): Promise<void> {
  const token = ensureCapabilityToken(options.stateDirectory).token;
  const port = options.port ?? DEFAULT_PORT;
  await openSessionMap({
    baseUrl: `http://127.0.0.1:${port}`,
    token,
    ...(options.browser ? { browser: options.browser } : {}),
  });
  console.log("SessionMap is visible in the browser.");
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
  const explicit = process.argv.includes("--state-dir") || Boolean(process.env.SESSIONMAP_STATE_DIR);
  const directory = explicit ? options.stateDirectory : `${defaultStateDirectory()} Demo`;
  const lock = new InstanceLock(directory);
  lock.acquire();
  try {
    const store = new StateStore(directory);
    await seedDemo(store, new TreeRuntime(store));
  } finally {
    lock.release();
  }
  console.log(`Demo state written to ${directory}`);
  console.log(`Run: sessionmap serve --state-dir ${JSON.stringify(directory)} --no-watch`);
}

async function status(options: Parsed): Promise<void> {
  if (!existsSync(join(options.stateDirectory, "state.json"))) {
    console.log("SessionMap has no state yet.");
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
  else if (options.command === "open") await openInstalled(options);
  else if (options.command === "once") await once(options);
  else if (options.command === "demo") await demo(options);
  else if (options.command === "install") console.log(`Installed ${await installLaunchAgent(options.stateDirectory)}`);
  else if (options.command === "uninstall") console.log(await uninstallLaunchAgent() ? "Uninstalled SessionMap." : "SessionMap was not installed.");
  else if (options.command === "status") await status(options);
  else throw new Error(`unknown command: ${options.command}`);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});

declare const __SESSIONMAP_VERSION__: string;
