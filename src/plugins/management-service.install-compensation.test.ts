import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import {
  installPackageDir,
  requestDeferredPackageDirInstall,
  resolvePackageDirInstallTransaction,
} from "../infra/install-package-dir.js";
import type { PluginCapabilityConsentHandler } from "./capability-consent.js";
import {
  attachPluginInstallTransaction,
  resolvePluginInstallTransaction,
  resolvePluginInstallTransactionRequest,
} from "./install-transaction.js";
import type { PluginInstallArtifactConsentHandler } from "./install-types.js";
import {
  PluginInstallPersistedError,
  PluginRuntimeApplicationError,
  projectPluginRuntimeFailure,
} from "./lifecycle.js";
import type { ManagedPluginSourceInstallRequest } from "./management-install.js";
import { recordPluginManifestInstallOwner } from "./manifest-install-owner.js";
import { createColdPluginFixture } from "./test-helpers/cold-plugin-fixtures.js";
import { invokePluginArtifactInstallMock } from "./test-helpers/install-fixtures.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
const mocks = vi.hoisted(() => ({ install: vi.fn(), commit: vi.fn() }));
vi.mock("./clawhub.js", () => ({ installPluginFromClawHub: mocks.install }));
vi.mock("./git-install.js", () => ({ installPluginFromGitSpec: mocks.install }));
vi.mock("./install.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./install.js")>()),
  installPluginFromNpmSpec: mocks.install,
  installPluginFromNpmPackArchive: mocks.install,
  installPluginFromPath: mocks.install,
}));
vi.mock("./marketplace.js", () => ({ installPluginFromMarketplace: mocks.install }));
vi.mock("./install-record-commit.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./install-record-commit.js")>()),
  commitPluginInstallRecordsWithConfig: mocks.commit,
}));
vi.mock("./installed-plugin-index-records.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./installed-plugin-index-records.js")>()),
  loadInstalledPluginIndexInstallRecords: async () => ({}),
}));
vi.mock("./discovery.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./discovery.js")>()),
  discoverOpenClawPlugins: () => ({ candidates: [], diagnostics: [] }),
}));
vi.mock("./manifest-registry.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./manifest-registry.js")>();
  return {
    ...actual,
    loadPluginManifestRegistryCore: (
      params: Parameters<typeof actual.loadPluginManifestRegistryCore>[0],
    ) =>
      params?.discovery
        ? actual.loadPluginManifestRegistryCore(params)
        : {
            plugins: Object.keys(params?.installRecords ?? {}).map((id) =>
              recordPluginManifestInstallOwner({ id, origin: "global" }, id),
            ),
            diagnostics: [],
          },
  };
});
vi.mock("./plugin-metadata-snapshot.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./plugin-metadata-snapshot.js")>()),
  loadPluginMetadataSnapshot: () => ({ index: { plugins: [] }, byPluginId: new Map() }),
}));
vi.mock("./slot-selection.js", () => ({
  applySlotSelectionForPlugin: (config: unknown) => config,
}));
vi.mock("./registry-refresh.js", () => ({
  refreshPluginRegistryAfterConfigMutation: async () => undefined,
}));
// mock-isolation: Keep status discovery and its persistent state outside the install fixture.
vi.mock("./status.js", () => ({
  buildPluginSnapshotReport: () => ({ plugins: [] }),
  buildPluginSnapshotReportAsync: async () => ({ plugins: [] }),
}));
const { installManagedPluginSource: installSource } = await import("./management-install.js");
const snapshot = { config: {}, baseHash: "base-hash", writeOptions: {} };
const acceptCapabilities: PluginCapabilityConsentHandler = async ({ reviewToken }) => ({
  reviewToken,
});
const installDefaults = { snapshot, onCapabilityConsent: acceptCapabilities };
function mockReviewedArtifact(transaction?: Parameters<typeof attachPluginInstallTransaction>[1]) {
  mocks.install.mockImplementation(
    (params: Parameters<typeof invokePluginArtifactInstallMock>[1]) =>
      invokePluginArtifactInstallMock(async () => {
        const artifact = { ok: true, pluginId: "demo", targetDir: "/managed/demo" };
        return transaction ? attachPluginInstallTransaction(artifact, transaction) : artifact;
      }, params),
  );
}
const settlements = {
  "authority-closed": { source: "local", path: "/incoming", recordSource: "path", mode: "update" },
  "before-commit": { source: "npm-pack", archivePath: "/incoming.tgz", mode: "update" },
  "runtime-apply": { source: "git", spec: "git:example/demo", mode: "update" },
  none: { source: "marketplace", marketplace: "local/repo", plugin: "demo", mode: "update" },
} satisfies Record<string, ManagedPluginSourceInstallRequest>;

beforeEach(() => {
  mocks.install.mockReset();
  mocks.commit.mockReset().mockImplementation(async ({ nextConfig }) => ({
    configWrite: {
      path: "/tmp/openclaw.json",
      nextConfig,
      persistedHash: "committed",
      persistedSourceConfig: nextConfig,
    },
  }));
});

it("returns the committed bundled configuration to the management owner", async () => {
  const config = { plugins: { entries: { demo: { enabled: true } } } };
  const installed = await installSource({
    snapshot,
    request: {
      source: "bundled",
      rawSpec: "demo",
      bundledSource: { pluginId: "demo", localPath: "/bundled/demo" },
    },
  });
  expect(installed).toMatchObject({ ok: true, config });
});

it("rechecks the initiating owner after awaited capability consent", async () => {
  const expired = new Error("approval owner expired during review");
  let current = true;
  mockReviewedArtifact();
  await expect(
    installSource({
      snapshot,
      request: {
        source: "local",
        path: "/incoming.tgz",
        recordSource: "archive",
        mode: "update",
      },
      onCapabilityConsent: async (review) => {
        await Promise.resolve();
        current = false;
        return { reviewToken: review.reviewToken };
      },
      beforePersistentEffect: () => {
        if (!current) {
          throw expired;
        }
      },
    }),
  ).rejects.toBe(expired);
  expect(mocks.commit).not.toHaveBeenCalled();
});

it.each(Object.entries(settlements))("settles payloads after %s", async (failure, request) => {
  const home = await fs.realpath(tempDirs.make("openclaw-managed-upgrade-"));
  const sourceDir = path.join(home, "incoming");
  const targetDir = path.join(home, "extensions", "demo");
  await fs.mkdir(sourceDir, { recursive: true });
  await fs.mkdir(targetDir, { recursive: true });
  createColdPluginFixture({
    rootDir: sourceDir,
    pluginId: "demo",
    packageVersion: "2.0.0",
    manifest: { contracts: { tools: ["demo.write"] } },
  });
  createColdPluginFixture({ rootDir: targetDir, pluginId: "demo", packageVersion: "1.0.0" });
  await fs.writeFile(path.join(sourceDir, "version"), "2.0.0");
  await fs.writeFile(path.join(targetDir, "version"), "1.0.0");
  const conflict =
    failure === "runtime-apply"
      ? new PluginRuntimeApplicationError(
          "plugin service failed to start",
          {
            operationId: "install-activation",
            generation: 3,
            pluginIds: ["demo"],
            phase: "activate",
            committed: false,
          },
          { cause: new Error("service startup failed") },
        )
      : new Error(failure);
  let active = true;
  if (failure === "before-commit") {
    mocks.commit.mockRejectedValue(conflict);
  }
  mocks.install.mockImplementation(
    async (params: {
      onBeforePluginArtifactCommit?: PluginInstallArtifactConsentHandler;
      beforePersistentApply?: () => void;
    }) => {
      const copy = {
        sourceDir,
        targetDir,
        mode: "update" as const,
        timeoutMs: 1000,
        copyErrorPrefix: "copy failed",
        hasDeps: false,
        depsLogMessage: "",
        beforePersistentApply: params.beforePersistentApply,
        afterInstall: async (stagedArtifactDir: string) => {
          await params.onBeforePluginArtifactCommit?.({
            pluginId: "demo",
            stagedArtifactDir,
            currentArtifactDir: targetDir,
            mode: "update",
          });
          return { ok: true as const };
        },
      };
      const transactionRequest = resolvePluginInstallTransactionRequest(params);
      const copied = await installPackageDir(
        transactionRequest
          ? requestDeferredPackageDirInstall(copy, transactionRequest.assertOwned)
          : copy,
      );
      if (!copied.ok) {
        throw new Error(copied.error);
      }
      const result = {
        ok: true,
        pluginId: "demo",
        targetDir,
        version: "2.0.0",
        extensions: [],
        marketplaceName: "Local",
        marketplaceSource: "local/repo",
        marketplacePlugin: "demo",
        git: { url: "https://example.test/demo.git" },
      };
      const transaction = resolvePackageDirInstallTransaction(copied);
      return transaction ? attachPluginInstallTransaction(result, transaction) : result;
    },
  );
  const onCapabilityConsent = vi.fn<PluginCapabilityConsentHandler>(async (review) => {
    expect(await fs.readFile(path.join(targetDir, "version"), "utf8")).toBe("1.0.0");
    active = failure !== "authority-closed";
    return await acceptCapabilities(review);
  });
  const installed = installSource({
    ...installDefaults,
    request,
    env: { HOME: home, OPENCLAW_STATE_DIR: path.join(home, "state") },
    applyRuntime:
      failure === "runtime-apply"
        ? async () => {
            throw conflict;
          }
        : undefined,
    onCapabilityConsent,
    beforePersistentApply: () => {
      if (!active) {
        throw conflict;
      }
    },
  });
  if (failure === "none") {
    await expect(installed).resolves.toMatchObject({ ok: true });
    expect(resolvePluginInstallTransaction({ ...(await installed) })).toBeUndefined();
  } else if (failure === "authority-closed") {
    await expect(installed).rejects.toThrow("authority-closed");
    expect(mocks.commit).not.toHaveBeenCalled();
  } else if (failure === "runtime-apply") {
    const rejected = await installed.catch((error: unknown) => error);
    expect(rejected).toBeInstanceOf(PluginInstallPersistedError);
    expect(rejected).toMatchObject({ pluginId: "demo" });
    if (rejected instanceof PluginInstallPersistedError) {
      expect(rejected.cause).toBe(conflict);
    }
    const projected = projectPluginRuntimeFailure(rejected);
    expect([projected.persistence, projected.runtime]).toEqual([
      { operation: "install", pluginId: "demo" },
      conflict instanceof PluginRuntimeApplicationError ? conflict.details : undefined,
    ]);
    expect(projected.message).toContain(conflict.message);
    expect(projected.message).toContain("service startup failed");
  } else {
    await expect(installed).rejects.toBe(conflict);
    expect(projectPluginRuntimeFailure(conflict)).not.toHaveProperty("persistence");
  }
  if (failure !== "authority-closed") {
    expect(mocks.commit.mock.calls[0]?.[0].nextInstallRecords.demo).toMatchObject({
      acceptedSurface: { tools: ["demo.write"] },
    });
    if (request.source === "marketplace") {
      expect(mocks.commit.mock.calls[0]?.[0].nextInstallRecords.demo).toMatchObject({
        source: "marketplace",
        marketplaceSource: request.marketplace,
        marketplacePlugin: request.plugin,
      });
    }
  }
  expect(onCapabilityConsent).toHaveBeenCalledOnce();
  expect(await fs.readFile(path.join(targetDir, "version"), "utf8"), failure).toBe(
    failure === "before-commit" || failure === "authority-closed" ? "1.0.0" : "2.0.0",
  );
  expect(await fs.readdir(path.join(home, "extensions", ".openclaw-install-backups"))).toEqual([]);
});

it("leaves linked operator source untouched when persistence fails", async () => {
  const sourcePath = tempDirs.make("openclaw-managed-link-");
  createColdPluginFixture({ rootDir: sourcePath, pluginId: "demo" });
  await fs.writeFile(path.join(sourcePath, "version"), "operator-owned");
  const conflict = new Error("config changed during plugin link");
  mocks.install.mockResolvedValue({ ok: true, pluginId: "demo", targetDir: sourcePath });
  mocks.commit.mockRejectedValue(conflict);
  await expect(
    installSource({
      ...installDefaults,
      request: {
        source: "local",
        path: sourcePath,
        recordSource: "path",
        mode: "install",
        link: true,
      },
    }),
  ).rejects.toBe(conflict);
  expect(mocks.install).toHaveBeenCalledWith(
    expect.objectContaining({ path: sourcePath, dryRun: true }),
  );
  expect(await fs.readFile(path.join(sourcePath, "version"), "utf8")).toBe("operator-owned");
});

it.each(["rollback", "commit"] as const)(
  "reports %s failure without reversing committed state",
  async (settlement) => {
    const conflict = new Error("config write rejected");
    const settlementError = new Error(`${settlement} failed`);
    const transaction = { commit: vi.fn(), rollback: vi.fn() };
    transaction[settlement].mockRejectedValue(settlementError);
    mockReviewedArtifact(transaction);
    if (settlement === "rollback") {
      mocks.commit.mockRejectedValue(conflict);
    }
    const runtime = { log: vi.fn(), error: vi.fn(), exit: vi.fn() };
    const installed = installSource({
      ...installDefaults,
      request: { source: "npm", spec: "demo@2.0.0", mode: "update" },
      runtime,
    });
    if (settlement === "rollback") {
      await expect(installed).rejects.toMatchObject({
        cause: conflict,
        errors: [conflict, settlementError],
      });
      expect(transaction.commit).not.toHaveBeenCalled();
    } else {
      const warning = "Plugin install committed, but backup cleanup failed.";
      await expect(installed).resolves.toMatchObject({ ok: true, warnings: [warning] });
      expect(runtime.log).toHaveBeenCalledWith(warning);
      expect(transaction.rollback).not.toHaveBeenCalled();
    }
  },
);
