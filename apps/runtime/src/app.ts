import { join } from "node:path";
import { ActionRouter } from "@sessionmap/core/actions.ts";
import { Logger } from "@sessionmap/core/logger.ts";
import { SessionMonitor } from "@sessionmap/core/monitor.ts";
import { SessionMapHttpServer } from "./server.ts";
import { InstanceLock } from "@sessionmap/core/instance-lock.ts";
import { StateStore } from "@sessionmap/core/state-store.ts";
import { TranscriptWatcher } from "@sessionmap/core/watcher.ts";
import { TreeRuntime } from "@sessionmap/core/tree.ts";

export interface AppOptions {
  stateDirectory: string;
  port?: number;
  watch?: boolean;
}

export class SessionMapApp {
  readonly logger: Logger;
  readonly lock: InstanceLock;
  readonly store: StateStore;
  readonly runtime: TreeRuntime;
  readonly actions: ActionRouter;
  readonly monitor: SessionMonitor;
  readonly watcher: TranscriptWatcher;
  readonly http: SessionMapHttpServer;
  #closed = false;

  constructor(readonly options: AppOptions) {
    this.logger = new Logger(join(options.stateDirectory, "server.log"));
    this.lock = new InstanceLock(options.stateDirectory);
    this.lock.acquire();
    try {
      this.store = new StateStore(options.stateDirectory, this.logger);
      this.runtime = new TreeRuntime(this.store);
      this.actions = new ActionRouter(this.store);
      this.monitor = new SessionMonitor(this.store, this.logger);
      this.watcher = new TranscriptWatcher(this.store, this.runtime, process.cwd(), this.logger);
      this.http = new SessionMapHttpServer({
        store: this.store,
        runtime: this.runtime,
        actions: this.actions,
        monitor: this.monitor,
        watcher: this.watcher,
        logger: this.logger,
      }, {
        stateDirectory: options.stateDirectory,
        ...(options.port !== undefined ? { port: options.port } : {}),
      });
    } catch (error) {
      this.lock.release();
      throw error;
    }
  }

  start(): void {
    this.monitor.start();
    if (this.options.watch !== false) this.watcher.start();
    this.logger.info("SessionMap started", { url: this.http.url, pid: process.pid });
  }

  stop(): void {
    if (this.#closed) return;
    this.#closed = true;
    this.watcher.stop();
    this.monitor.stop();
    this.http.stop();
    this.lock.release();
    this.logger.info("SessionMap stopped", { pid: process.pid });
  }
}
