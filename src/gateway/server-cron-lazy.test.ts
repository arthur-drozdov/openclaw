/**
 * Tests lazy cron startup behavior in the gateway server.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createDeferred as deferred } from "../../test/helpers/promise.js";
import type { CliDeps } from "../cli/deps.types.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { createMockCronStateForJobs } from "../cron/service.test-harness.js";
import { listPage } from "../cron/service/ops-read.js";
import type { CronJob } from "../cron/types.js";
import {
  createSqliteReadOnlyWorkerScope,
  isSqliteInspectionDeadlineOwnedByCaller,
} from "../infra/sqlite-readonly-worker.js";
import { getSpawnBroker, runWithSpawnBroker } from "../process/spawn-broker/context.js";
import { useSpawnBrokerTestFixture } from "../process/spawn-broker/host.test-support.js";
import { runInDetachedAsyncContext } from "../shared/detached-async-context.js";
import { createTestGatewayScheduler } from "../test-utils/gateway-scheduler-clock.js";
import type { GatewayCronServiceContract } from "./server-cron-contract.js";
import type { GatewayCronState } from "./server-cron.js";

const hoisted = vi.hoisted(() => {
  let state: unknown;
  return {
    buildGatewayCronService: vi.fn(() => state),
    setState(nextState: unknown) {
      state = nextState;
    },
  };
});

vi.mock("./server-cron.js", () => ({
  buildGatewayCronService: hoisted.buildGatewayCronService,
}));

const { createLazyGatewayCronState } = await import("./server-cron-lazy.js");

describe("createLazyGatewayCronState", () => {
  const createBroker = useSpawnBrokerTestFixture(afterEach);
  beforeEach(() => {
    vi.unstubAllEnvs();
    hoisted.buildGatewayCronService.mockClear();
  });

  it("does not build the heavy cron service until an async cron operation needs it", async () => {
    const broker = await createBroker();
    const cron = createCronService();
    const state = createCronState(cron);
    hoisted.setState(state);
    let observedBroker: unknown = "not-built";
    let observedReadOnlyScope = false;
    hoisted.buildGatewayCronService.mockImplementationOnce(() => {
      observedBroker = getSpawnBroker();
      observedReadOnlyScope = isSqliteInspectionDeadlineOwnedByCaller();
      return state;
    });

    const readers = createSqliteReadOnlyWorkerScope({
      signal: new AbortController().signal,
      deadlineOwnedByCaller: true,
    });
    const lazy = readers.run(() =>
      runWithSpawnBroker(broker, () => createLazyGatewayCronState(createParams())),
    );

    expect(hoisted.buildGatewayCronService).not.toHaveBeenCalled();
    expect(lazy.cron.getJob("demo")).toBeUndefined();
    expect(lazy.cron.getDefaultAgentId()).toBeUndefined();

    try {
      await runInDetachedAsyncContext(() => lazy.cron.status());
    } finally {
      await readers.close();
    }

    expect(hoisted.buildGatewayCronService).toHaveBeenCalledTimes(1);
    expect(cron["status"]).toHaveBeenCalledTimes(1);
    expect(observedBroker === broker).toBe(true);
    expect(observedReadOnlyScope).toBe(true);
  });

  it("does not load cron solely to prepare a watcher handoff", async () => {
    const lazy = createLazyGatewayCronState(createParams());

    await expect(lazy.prepareExitWatcherHandoff?.()).resolves.toBeUndefined();
    expect(hoisted.buildGatewayCronService).not.toHaveBeenCalled();
  });

  it("keeps visibility filtering inside the loaded service's page snapshot", async () => {
    const jobs: CronJob[] = ["hidden", "visible"].map((id) => ({
      id,
      name: id,
      enabled: false,
      createdAtMs: 1,
      updatedAtMs: 1,
      schedule: { kind: "every", everyMs: 60_000, anchorMs: 1 },
      sessionTarget: "main",
      wakeMode: "now",
      payload: { kind: "systemEvent", text: "tick" },
      state: {},
    }));
    const store = createMockCronStateForJobs({ jobs });
    const cron = createCronService();
    const start = vi.spyOn(cron, "start");
    cron.listPage = (opts, matchesJob) => listPage(store, opts, matchesJob);
    hoisted.setState(createCronState(cron));

    const lazy = createLazyGatewayCronState(createParams());
    const page = await lazy.cron.listPage(
      { includeDisabled: true, limit: 1, sortBy: "name" },
      (job) => job.id === "visible",
    );

    expect(page).toMatchObject({ total: 1, hasMore: false, jobs: [jobs[1]] });
    expect(start).not.toHaveBeenCalled();
  });

  it("preserves a watcher owner when hot reload overtakes lazy startup", async () => {
    const finishStart = deferred();
    const cron = createCronService();
    cron.start = vi.fn(async () => await finishStart.promise);
    const watchers = {
      reconcile: vi.fn(),
      cancel: vi.fn(),
      cancelAll: vi.fn(async () => {}),
      activeJobIds: vi.fn(() => ["watched-job"]),
      updateHandlers: vi.fn(),
    };
    const stopOwner = vi.fn(async () => {});
    const prepareExitWatcherHandoff = vi.fn(async () => ({
      current: () => watchers,
      adopt: vi.fn(),
      stopOwner,
    }));
    hoisted.setState({
      ...createCronState(cron),
      prepareExitWatcherHandoff,
    });
    const lazy = createLazyGatewayCronState(createParams());

    const start = lazy.cron.start();
    await vi.waitFor(() => expect(cron["start"]).toHaveBeenCalledOnce());
    const handoff = await lazy.prepareExitWatcherHandoff?.();
    expect(handoff?.current()).toBe(watchers);

    await handoff?.stopOwner();
    finishStart.resolve();
    await start;
    await handoff?.stopOwner();

    expect(prepareExitWatcherHandoff).toHaveBeenCalledOnce();
    expect(stopOwner).toHaveBeenCalledOnce();
    expect(watchers.cancelAll).not.toHaveBeenCalled();
    expect(cron["stop"]).not.toHaveBeenCalled();
  });

  it("forwards update authority options through lazy cron loading", async () => {
    const cron = createCronService();
    hoisted.setState(createCronState(cron));

    const lazy = createLazyGatewayCronState(createParams());
    const opts = {
      commitGuard: vi.fn(),
      captureRuntimeAuthority: vi.fn(() => undefined),
    };
    const precondition = vi.fn();
    await lazy.cron.update("demo", { description: "updated" }, opts);
    await lazy.cron.updateWithPrecondition(
      "demo",
      { description: "updated again" },
      precondition,
      opts,
    );

    expect(cron["update"]).toHaveBeenCalledExactlyOnceWith(
      "demo",
      { description: "updated" },
      opts,
    );
    expect(cron["updateWithPrecondition"]).toHaveBeenCalledExactlyOnceWith(
      "demo",
      { description: "updated again" },
      precondition,
      opts,
    );
  });

  it("preserves system-owned removal authority across lazy cron loading", async () => {
    const cron = createCronService();
    hoisted.setState(createCronState(cron));

    const lazy = createLazyGatewayCronState(createParams());
    await lazy.cron.remove("heartbeat-monitor", { systemOwned: true });

    expect(cron["remove"]).toHaveBeenCalledExactlyOnceWith("heartbeat-monitor", {
      systemOwned: true,
    });
  });

  it("prepares a lazy scheduler before an operator wake without starting it", async () => {
    const cron = createCronService();
    hoisted.setState(createCronState(cron));

    const lazy = createLazyGatewayCronState(createParams());
    await lazy.cron.prepareWake?.();

    expect(await lazy.cron.wake({ mode: "now", text: "ping" })).toEqual({ ok: true });
    expect(cron["start"]).not.toHaveBeenCalled();
    expect(cron["wake"]).toHaveBeenCalledExactlyOnceWith({ mode: "now", text: "ping" });
  });

  it.each(["run", "enqueueRun"] as const)(
    "finishes startup recovery before admitting a manual %s",
    async (operation) => {
      const recoveryStarted = deferred();
      const recoveryFinished = deferred();
      const cron = createCronService();
      const start = vi.fn(async () => {
        recoveryStarted.resolve();
        await recoveryFinished.promise;
      });
      cron.start = start;
      hoisted.setState(createCronState(cron));
      const lazy = createLazyGatewayCronState(createParams());

      const run = lazy.cron[operation]("demo", "force");
      await Promise.race([
        recoveryStarted.promise,
        run.then(() => {
          throw new Error("Manual cron run was admitted before startup recovery");
        }),
      ]);
      expect(cron[operation]).not.toHaveBeenCalled();
      recoveryFinished.resolve();
      await run;

      expect(cron[operation]).toHaveBeenCalledExactlyOnceWith("demo", "force");
    },
  );

  it.each(["run", "enqueueRun"] as const)(
    "keeps a stopped scheduler stopped when a manual %s arrives",
    async (operation) => {
      const cron = createCronService();
      const start = vi.fn(async () => undefined);
      const stop = vi.fn();
      cron.start = start;
      cron.stop = stop;
      hoisted.setState(createCronState(cron));
      const lazy = createLazyGatewayCronState(createParams());
      await lazy.cron.status();
      lazy.cron.stop();

      await lazy.cron[operation]("demo", "force");

      expect(start).not.toHaveBeenCalled();
      expect(stop).toHaveBeenCalledOnce();
      expect(cron[operation]).toHaveBeenCalledExactlyOnceWith("demo", "force");
    },
  );

  it("does not start cron after stop wins the lazy startup race", async () => {
    const cron = createCronService();
    hoisted.setState(createCronState(cron));

    const lazy = createLazyGatewayCronState(createParams());
    const startPromise = lazy.cron.start();

    lazy.cron.stop();
    await startPromise;

    expect(cron["start"]).not.toHaveBeenCalled();
    expect(cron["stop"]).toHaveBeenCalledTimes(1);
  });

  it("keeps wake non-blocking before the cron service is loaded", async () => {
    const cron = createCronService();
    hoisted.setState(createCronState(cron));

    const lazy = createLazyGatewayCronState(createParams());

    expect(await lazy.cron.wake({ mode: "now", text: "ping" })).toEqual({ ok: false });

    await vi.waitFor(() => {
      expect(hoisted.buildGatewayCronService).toHaveBeenCalledTimes(1);
    });
    expect(cron["wake"]).not.toHaveBeenCalled();
  });

  it("forwards scheduling intent without loading the cron owner", async () => {
    const cron = createCronService();
    hoisted.setState(createCronState(cron));
    const lazy = createLazyGatewayCronState(createParams());

    lazy.cron.pauseScheduling();
    expect(hoisted.buildGatewayCronService).not.toHaveBeenCalled();
    lazy.cron.resumeScheduling();
    expect(hoisted.buildGatewayCronService).not.toHaveBeenCalled();
    lazy.cron.pauseScheduling();

    await lazy.cron.status();
    expect(cron["pauseScheduling"]).toHaveBeenCalledOnce();
    lazy.cron.resumeScheduling();
    expect(cron["resumeScheduling"]).toHaveBeenCalledOnce();
    lazy.cron.pauseScheduling();
    lazy.cron.resumeScheduling();
    expect(cron["resumeScheduling"]).toHaveBeenCalledTimes(2);
  });

  it("allows startup to retry after the underlying service rejects", async () => {
    const cron = createCronService();
    cron.start = vi
      .fn()
      .mockRejectedValueOnce(new Error("startup failed"))
      .mockResolvedValueOnce(undefined);
    hoisted.setState(createCronState(cron));
    const lazy = createLazyGatewayCronState(createParams());

    await expect(lazy.cron.start()).rejects.toThrow("startup failed");
    await lazy.cron.start();

    expect(cron["start"]).toHaveBeenCalledTimes(2);
  });

  it("forwards watcher reconciliation and teardown hooks through the proxy", async () => {
    const cron = createCronService();
    const state = createCronState(cron);
    hoisted.setState(state);

    const lazy = createLazyGatewayCronState(createParams());

    // Teardown before load must not force the heavy import.
    await lazy.stopStreamWatchers();
    expect(hoisted.buildGatewayCronService).not.toHaveBeenCalled();

    await lazy.reconcileExitWatchers();
    await lazy.reconcileStreamWatchers();
    expect(state.reconcileExitWatchers).toHaveBeenCalledTimes(1);
    expect(state.reconcileStreamWatchers).toHaveBeenCalledTimes(1);

    await lazy.stopStreamWatchers();
    expect(state.stopStreamWatchers).toHaveBeenCalledTimes(1);
  });
});

function createParams(overrides: Partial<OpenClawConfig> = {}) {
  return {
    storePath: "/tmp/openclaw-cron.json",
    scheduler: createTestGatewayScheduler(),
    cfg: {
      ...overrides,
    } as OpenClawConfig,
    deps: {} as CliDeps,
    broadcast: vi.fn(),
  };
}

function createCronState(cron: GatewayCronServiceContract): GatewayCronState {
  return {
    cron,
    storePath: "/tmp/openclaw-cron.json",
    cronEnabled: true,
    reconcileExitWatchers: vi.fn(async () => {}),
    reconcileStreamWatchers: vi.fn(async () => {}),
    stopStreamWatchers: vi.fn(async () => {}),
    reconcileSystemJobs: vi.fn(async () => "converged" as const),
  } satisfies GatewayCronState;
}

function createCronService(): GatewayCronServiceContract {
  return {
    start: vi.fn(async () => undefined),
    stop: vi.fn(),
    pauseScheduling: vi.fn(),
    resumeScheduling: vi.fn(),
    status: vi.fn(async () => ({ enabled: true }) as never),
    list: vi.fn(async () => [] as never),
    listPage: vi.fn(async () => ({ items: [], total: 0 }) as never),
    add: vi.fn(async () => ({ ok: true }) as never),
    update: vi.fn(async () => ({ ok: true }) as never),
    updateWithPrecondition: vi.fn(async () => ({ ok: true }) as never),
    remove: vi.fn(async () => ({ ok: true }) as never),
    removeStaleJobFamily: vi.fn(async () => 0),
    removeAgentJobsTransactional: vi.fn(async (_agentId, commit) => await commit()),
    quiesceJobs: vi.fn(async (_jobs, commitGuard) => {
      commitGuard();
    }),
    run: vi.fn(async () => ({ ok: true, ran: false, reason: "invalid-spec" }) as never),
    enqueueRun: vi.fn(async () => ({ ok: true, ran: false, reason: "invalid-spec" }) as never),
    readEventSources: vi.fn<GatewayCronServiceContract["readEventSources"]>(async () => []),
    runEvent: vi.fn<GatewayCronServiceContract["runEvent"]>(async () => ({ kind: "invalidated" })),
    waitForManualRun: vi.fn(async () => true),
    getJob: vi.fn(() => undefined),
    readJob: vi.fn(async () => undefined),
    readScratch: vi.fn(async () => ({ currentRevision: 0 })),
    writeScratch: vi.fn(async () => ({ ok: true, currentRevision: 1 }) as never),
    getDefaultAgentId: vi.fn(() => "default"),
    wake: vi.fn(async () => ({ ok: true })),
  };
}
