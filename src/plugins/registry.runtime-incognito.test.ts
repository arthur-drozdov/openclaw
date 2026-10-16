import "../test-utils/prepare-compiled-subprocesses.js";
import path from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, expect, it, onTestFinished, vi } from "vitest";
import { awaitGateBeforeSettlement } from "../../test/helpers/promise.js";
import { observeHostDataSql } from "../../test/helpers/sqlite-statement-execution-counter.js";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import {
  clearRuntimeConfigSnapshot,
  setRuntimeConfigSnapshot,
} from "../config/runtime-snapshot.js";
import { memorySessionActorOwners } from "../config/sessions/session-actor-memory-owner.js";
import {
  acquireSessionActorStorage,
  runWithSessionActorStorage,
  type SelectedSessionActorStorageBinding,
} from "../config/sessions/session-actor-storage-binding.js";
import type { InternalSessionEntry } from "../config/sessions/types.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import * as gatewayCreation from "../gateway/session-create-service.js";
import { createDeferredCore } from "../shared/deferred.js";
import { resolveIncognitoOpenClawAgentSqlitePath } from "../state/openclaw-agent-db.paths.js";
import { createPluginRecord } from "./loader-records.js";
import { createRuntimeTestRegistry } from "./registry-runtime.test-helpers.js";
import { createPluginRuntime } from "./runtime/index.js";

const dirs = useAutoCleanupTempDirTracker(afterAll);
const authority = { assertCurrent() {}, authorize() {} };
const lifetime = { assertCurrent() {}, assertReadable() {} };
let stateDir: string;
let storePath: string;

async function withMemoryActor<T>(
  sessionKey: string,
  run: (binding: SelectedSessionActorStorageBinding) => T | Promise<T>,
) {
  const binding = await acquireSessionActorStorage(
    { agentId: "main", storePath, sessionKey },
    { authority, lifetime, create: true },
  );
  if (!binding) {
    throw new Error("Expected memory acquisition");
  }
  try {
    return await run(binding);
  } finally {
    await binding.actor.release();
  }
}

function withMemorySession<T>(sessionKey: string, run: () => T | Promise<T>) {
  return withMemoryActor(sessionKey, (binding) => runWithSessionActorStorage(binding, run));
}

function createMemoryEntry(
  sessionKey: string,
  sessionId: string,
  entry: Partial<InternalSessionEntry> = {},
) {
  return withMemoryActor(sessionKey, (binding) =>
    binding.actor.storage.mutate(
      {
        type: "session.entry.create",
        input: { entry: { sessionId, updatedAt: Date.now(), incognito: true, ...entry } },
      },
      authority,
    ),
  );
}

function observeSql() {
  const sql = observeHostDataSql();
  onTestFinished(() => sql.restore());
  return sql;
}

beforeAll(() => {
  stateDir = path.join(dirs.make("plugin-incognito-"), "state");
  storePath = resolveIncognitoOpenClawAgentSqlitePath({
    agentId: "main",
    env: { OPENCLAW_STATE_DIR: stateDir },
  });
});

beforeEach(() => {
  vi.stubEnv("OPENCLAW_STATE_DIR", stateDir);
});

afterAll(() => {
  memorySessionActorOwners.closeDatabase({ agentId: "main", path: storePath });
  vi.unstubAllEnvs();
});

afterEach(() => {
  vi.restoreAllMocks();
});

function registry() {
  const subagentRun = vi.fn(async () => ({ runId: "unexpected" }));
  const runtime = createPluginRuntime({
    subagent: {
      complete: async () => ({ text: "" }),
      forkSession: async () => ({ text: "" }),
      run: subagentRun,
      waitForRun: async () => ({ status: "ok" }),
      getSessionMessages: async () => ({ messages: [] }),
      deleteSession: async () => {},
    },
  });
  const plugins = createRuntimeTestRegistry(runtime);
  const api = (id: string) =>
    plugins.createApi(
      createPluginRecord({
        id,
        source: `/plugins/${id}/index.js`,
        origin: "bundled",
        enabled: true,
        configSchema: false,
      }),
      { config: {} },
    );
  const owner = api("owner");
  const caller = api("caller");
  const harness = {
    id: "test-harness",
    label: "Test harness",
    delegatedExecutionPluginIds: ["caller"],
    supports: () => ({ supported: true as const }),
    runAttempt: async () => {
      throw new Error("unused");
    },
  };
  owner.registerAgentHarness(harness);
  return { runtime, owner, caller, harness, subagentRun };
}

it("keeps memory ownership and by-ID checks out of host SQL", async () => {
  const { owner, caller, subagentRun } = registry();
  const key = "agent:main:dashboard:incognito-plugin-owned";
  const sessionId = "plugin-owned";
  await createMemoryEntry(key, sessionId, {
    agentHarnessId: "test-harness",
    modelSelectionLocked: true,
  });
  const sql = observeSql();
  await expect(
    caller.runtime.subagent.run({ sessionKey: key, message: "forbidden" }),
  ).rejects.toThrow('owned by plugin "owner"');
  await withMemorySession(key, async () => {
    await expect(caller.runtime.gateway.request("sessions.abort", { sessionId })).rejects.toThrow(
      'owned by plugin "owner"',
    );
  });
  const session = owner.runtime.agent.session;
  await expect(
    session.patchSessionEntry({
      sessionKey: key,
      storePath,
      update: () => ({ displayName: "owned update" }),
    }),
  ).resolves.toMatchObject({ displayName: "owned update" });
  await expect(session.getSessionEntryAsync({ sessionKey: key, storePath })).resolves.toMatchObject(
    { displayName: "owned update" },
  );
  expect(subagentRun).not.toHaveBeenCalled();
  expect(sql.queries).toEqual([]);
});

it("classifies sandbox authority from its captured actor despite a different configured store", async () => {
  const { owner } = registry();
  const sessionKey = "agent:main:dashboard:incognito-workspace-policy";
  await createMemoryEntry(sessionKey, "workspace-policy", { updatedAt: 1, sandbox: "required" });
  const config: OpenClawConfig = {
    session: {
      store: resolveIncognitoOpenClawAgentSqlitePath({
        agentId: "main",
        env: { OPENCLAW_STATE_DIR: dirs.make("plugin-sandbox-other-root-") },
      }),
    },
    agents: {
      defaults: { sandbox: { mode: "off", scope: "session", workspaceAccess: "rw" } },
      entries: { main: {} },
    },
  };
  const params = { config, agentId: "main", sessionKey, storePath };
  const sql = observeSql();
  await withMemorySession(sessionKey, async () => {
    const sandbox = owner.runtime.sandbox;
    const expected = {
      sandboxed: true,
      workspaceAccess: "ro",
      confinementError: "target sandbox is not exclusive to this worker session.",
    };
    expect(sandbox.resolveWorkspaceAuthority(params)).toEqual(expected);
    await expect(
      sandbox.prepareWorkspaceAuthority({ ...params, workspaceDir: "/workspace" }),
    ).resolves.toEqual(expected);
  });
  expect(sql.queries).toEqual([]);
});

it("rechecks delegated harness authority after admission waits", async () => {
  setRuntimeConfigSnapshot({});
  onTestFinished(clearRuntimeConfigSnapshot);
  const { runtime, caller, harness } = registry();
  const key = "agent:main:dashboard:incognito-delegated";
  await createMemoryEntry(key, "delegated", {
    agentHarnessId: harness.id,
    modelSelectionLocked: true,
  });
  const entered = createDeferredCore();
  const release = createDeferredCore();
  const original = runtime.agent.session.runWithWorkAdmission;
  runtime.agent.session.runWithWorkAdmission = async (params, run) => {
    entered.resolve();
    await release.promise;
    return original(params, run);
  };
  const run = vi.fn(async () => "must-not-run");
  const sql = observeSql();
  onTestFinished(() => release.resolve());
  const work = withMemorySession(key, () =>
    caller.runtime.agent.session.runWithWorkAdmission({ storePath, sessionKey: key }, run),
  );
  const rejected = expect(work).rejects.toThrow('owned by plugin "owner"');
  await awaitGateBeforeSettlement(entered.promise, work, "delegated admission did not enter");
  harness.delegatedExecutionPluginIds.length = 0;
  release.resolve();
  await rejected;
  expect(run).not.toHaveBeenCalled();
  expect(sql.queries).toEqual([]);
});

it.each(["finalize", "rollback", "changed" as const])(
  "%s retains the exact actor initializer",
  async (outcome) => {
    const { owner, harness } = registry();
    const key = `agent:main:dashboard:incognito-initialize-${outcome}`;
    const initialEntry = {
      agentHarnessId: harness.id,
      modelSelectionLocked: true as const,
      pluginExtensions: { test: { initializing: true } },
    };
    await createMemoryEntry(key, `initialize-${outcome}`, {
      ...initialEntry,
      initializationPending: true,
    });
    const sql = observeSql();
    await withMemorySession(key, async () => {
      const session = owner.runtime.agent.session;
      const creation = session.createSessionEntry({
        cfg: {},
        key,
        initialEntry,
        recoverMatchingInitialEntry: true,
        afterCreate: async ({ initialization }) => {
          if (!initialization) {
            throw new Error("session creation did not supply its initializer");
          }
          initialization.assertCurrent();
          if (outcome === "rollback") {
            throw new Error("initializer rejected");
          }
          if (outcome === "changed") {
            await session.patchSessionEntry({
              sessionKey: key,
              storePath,
              update: () => ({ displayName: "concurrent owner" }),
            });
            initialization.assertCurrent();
          }
          return { pluginExtensions: { test: { initialized: true } } };
        },
      });
      if (outcome === "finalize") {
        const created = await creation;
        expect(created).toMatchObject({
          entry: { pluginExtensions: { test: { initialized: true } } },
        });
        expect(created.entry.initializationPending).toBeUndefined();
      } else {
        await expect(creation).rejects.toThrow(
          outcome === "rollback" ? "initializer rejected" : "guarded rollback did not complete",
        );
      }
      const stored = await session.getSessionEntryAsync({ sessionKey: key, storePath });
      if (outcome === "rollback") {
        expect(stored).toBeUndefined();
      }
      if (outcome === "changed") {
        expect(stored?.displayName).toBe("concurrent owner");
      }
    });
    expect(sql.queries).toEqual([]);
  },
);

it("hands memory creation to the existing Gateway creator", async () => {
  const { owner, harness } = registry();
  const create = vi
    .spyOn(gatewayCreation, "createGatewaySession")
    .mockRejectedValue(new Error("creator refused"));
  const key = "agent:main:dashboard:incognito-plugin-create";
  const sql = observeSql();
  await expect(
    withMemorySession(key, () =>
      owner.runtime.agent.session.createSessionEntry({
        cfg: {},
        key,
        initialEntry: { agentHarnessId: harness.id, modelSelectionLocked: true },
      }),
    ),
  ).rejects.toThrow("creator refused");
  expect(create).toHaveBeenCalledWith(
    expect.objectContaining({ key, incognito: true, authorizedAgentHarnessId: harness.id }),
  );
  expect(sql.queries).toEqual([]);
});
