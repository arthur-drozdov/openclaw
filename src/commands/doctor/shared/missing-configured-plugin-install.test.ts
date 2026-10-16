// Register suite mocks before imports that read the install catalog.
import "./missing-configured-plugin-install.suite.test-support.js";
import fs from "node:fs";
import path from "node:path";
import { root as fsSafeRoot, type Root } from "@openclaw/fs-safe/root";
import { expectDefined } from "@openclaw/normalization-core";
import { describe, expect, it, vi } from "vitest";
import { PLUGIN_CAPABILITY_CONSENT_REQUIRED } from "../../../../packages/gateway-protocol/src/capability-consent-error-details.js";
import type { OpenClawConfigWithLegacyRoster } from "../../../config/legacy.roster.js";
import type { OpenClawConfig } from "../../../config/types.js";
import {
  installPackageDir,
  requestDeferredPackageDirInstall,
  resolvePackageDirInstallTransaction,
} from "../../../infra/install-package-dir.js";
import { normalizeComparablePath } from "../../../infra/install-package-dir.test-support.js";
import { resolvePluginArtifactDeclaredSurface } from "../../../plugins/capability-artifact.js";
import type { PluginCapabilityConsentHandler } from "../../../plugins/capability-consent.js";
import { computeDeclaredSurfaceHash } from "../../../plugins/capability-summary.js";
import {
  attachPluginInstallTransaction,
  resolvePluginInstallTransactionRequest,
} from "../../../plugins/install-transaction.js";
import type { PluginInstallArtifactConsentHandler } from "../../../plugins/install-types.js";
import { readPersistedInstalledPluginIndex as readIndex } from "../../../plugins/installed-plugin-index-store.js";
import { isTrustedOfficialPluginInstallRecord } from "../../../plugins/official-external-install-records.js";
import { withPluginLifecycleLease } from "../../../plugins/plugin-lifecycle-lease.js";
import { createColdPluginFixture } from "../../../plugins/test-helpers/cold-plugin-fixtures.js";
import { seedInstalledPluginIndex } from "../../../plugins/test-helpers/installed-plugin-index.js";
import { closeOpenClawStateDatabaseByPathAsync as closeDatabase } from "../../../state/openclaw-state-db-cache.js";
import { resolveOpenClawStateSqlitePath as statePath } from "../../../state/openclaw-state-db.paths.js";
import { VERSION } from "../../../version.js";
import { collectConfiguredNpmPluginTargets } from "./missing-configured-plugin-install.targets.js";
import {
  brokenPluginSnapshot,
  channelPluginEntry,
  configuredPlugin,
  installedRecords,
  officialPluginEntry,
  officialWebSearchPluginEntry,
  successfulInstall,
  successfulUpdate,
} from "./missing-configured-plugin-install.test-helpers.js";

const {
  expectedNpmInstallSpec,
  expectedClawHubInstallSpec,
  expectedCodexInstallSpec,
  mockNpmRegistryTags,
  expectRecordFields,
  mockCallArg,
  expectedIndexWriteOptions,
  mockCurrentBundledPlugin,
  repairConfiguredPlugins,
  useRealInstallIndexWrites,
  useManifestCatalogResolvers,
  mockBrokenBraveInstall,
  mocks,
  testEnv,
  tempDirs,
  prepareManagedPluginArtifactConsentHandler: prepareConsent,
  setupPluginInstallSuite,
} = await import("./missing-configured-plugin-install.suite.test-support.js");

const {
  writePersistedInstalledPluginIndexInstallRecordsWithLease: persistRecords,
  installPluginFromNpmSpec: installNpm,
  installPluginFromClawHub: installClawHub,
} = mocks;

const { repairMissingConfiguredPluginInstalls: repairInstalls, repairMissingPluginInstallsForIds } =
  await import("./missing-configured-plugin-install.js");

const CODEX = "@openclaw/codex";
const BRAVE = "@openclaw/brave-plugin";
const MATRIX = "@openclaw/plugin-matrix";
const BUNDLED = "@openclaw/bundleddemo";
const FIRECRAWL = "@openclaw/firecrawl-plugin";
const installedMessage = (id: string, spec: string) =>
  `Installed missing configured plugin "${id}" from ${spec}.`;
const refreshedMessage = (id: string, spec: string) =>
  `Refreshed stale configured plugin "${id}" from ${spec}.`;

function notCalled(...callbacks: ReturnType<typeof vi.fn>[]) {
  for (const callback of callbacks) {
    expect(callback).not.toHaveBeenCalled();
  }
}

function metadata(plugins: unknown[], diagnostics: unknown[] = [], index?: unknown) {
  mocks.loadPluginMetadataSnapshot.mockReturnValue({
    plugins,
    diagnostics,
    ...(index === undefined ? {} : { index }),
  });
}

function setChannels(...entries: Record<string, unknown>[]) {
  mocks.listChannelPluginCatalogEntries.mockReturnValue(entries);
}
function setOfficial(...entries: Record<string, unknown>[]) {
  mocks.listOfficialExternalPluginCatalogEntries.mockReturnValue(entries);
}

function catalogChannel(id: string, install: Record<string, unknown>, label: string) {
  return { id, pluginId: id, meta: { label }, install };
}

function npmRecords(
  id: string,
  spec: string,
  installPath: string,
  extra: Record<string, unknown> = {},
) {
  return installedRecords(id, { spec, installPath, ...extra });
}

function artifact(
  pluginId: string,
  npmSpec: string,
  version?: string,
  targetDir?: string,
  resolution?: Record<string, unknown>,
) {
  return successfulInstall({ pluginId, npmSpec, version, targetDir, resolution });
}

function coldFixture(
  rootDir: string,
  pluginId: string,
  packageName: string,
  packageVersion?: string,
  tools?: string[],
) {
  fs.mkdirSync(rootDir, { recursive: true });
  return createColdPluginFixture({
    rootDir,
    pluginId,
    packageName,
    packageVersion,
    ...(tools ? { manifest: { contracts: { tools } } } : {}),
  });
}

function bundledDemo(bundledRoot?: string) {
  setChannels({
    ...catalogChannel("bundleddemo", { npmSpec: BUNDLED }, "Matrix"),
    origin: "bundled",
  });
  metadata(
    [{ id: "bundleddemo", origin: "bundled", packageName: BUNDLED, channels: ["bundleddemo"] }],
    [{ pluginId: "bundleddemo", message: "manifest without channelConfigs metadata" }],
  );
  mockCurrentBundledPlugin("bundleddemo", BUNDLED, bundledRoot);
  return {
    plugins: { entries: { bundleddemo: { enabled: true } } },
    channels: { bundleddemo: { enabled: true, homeserver: "https://bundleddemo.example.org" } },
  };
}

const consentFailure = (pluginId: string) =>
  expect.objectContaining({ pluginId, status: "error", code: PLUGIN_CAPABILITY_CONSENT_REQUIRED });
const acceptCapabilities = () =>
  vi.fn<PluginCapabilityConsentHandler>(async (review) => ({ reviewToken: review.reviewToken }));

const retainedPayload = "export const retained = true;\n";

function writeStub(dir: string, name: string, payload?: string) {
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "package.json"), JSON.stringify({ name }));
  if (payload !== undefined) {
    fs.writeFileSync(path.join(dir, "index.ts"), payload);
  }
}

function pluginEntries(...ids: string[]): OpenClawConfig {
  return { plugins: { entries: Object.fromEntries(ids.map((id) => [id, { enabled: true }])) } };
}

function pluginRoots(root: string) {
  const npmRoot = path.join(root, "npm");
  mocks.resolveDefaultPluginNpmDir.mockReturnValue(npmRoot);
  mocks.resolveDefaultPluginExtensionsDir.mockReturnValue(path.join(root, "extensions"));
  return npmRoot;
}

function readText(...segments: string[]) {
  return fs.readFileSync(path.join(...segments), "utf8");
}

function fileBytes(dir: string) {
  return fs
    .readdirSync(dir)
    .map((file) => ({ file, bytes: fs.readFileSync(path.join(dir, file)) }));
}

function expectFiles(dir: string, files: ReturnType<typeof fileBytes>) {
  for (const { file, bytes } of files) {
    expect(fs.readFileSync(path.join(dir, file))).toEqual(bytes);
  }
}

function expectLink(link: string, target: string) {
  expect(fs.lstatSync(link).isSymbolicLink()).toBe(true);
  expect(fs.realpathSync(link)).toBe(fs.realpathSync(target));
}

function brokenBrave() {
  const root = tempDirs.make("openclaw-doctor-brave-");
  const env = { ...testEnv, OPENCLAW_STATE_DIR: path.join(root, "state") };
  const extensionsDir = path.join(root, "extensions");
  const installDir = path.join(extensionsDir, "brave");
  const cfg = { tools: { web: { search: { provider: "brave" } } } } satisfies OpenClawConfig;
  const priorRecord = {
    source: "npm" as const,
    spec: "@openclaw/brave-plugin@2026.5.1-beta.1",
    installPath: installDir,
  };
  mocks.resolveDefaultPluginExtensionsDir.mockReturnValue(extensionsDir);
  return { root, env, extensionsDir, installDir, cfg, priorRecord };
}

function stageBrave(rootDir: string) {
  coldFixture(rootDir, "brave", BRAVE, "2026.5.12");
}

function installedCodex(version: string, spec = CODEX, readFromDisk = false) {
  const installDir = tempDirs.make("openclaw-doctor-codex-");
  const packageFile = path.join(installDir, "package.json");
  const writePackageVersion = (next: string) =>
    fs.writeFileSync(packageFile, JSON.stringify({ name: CODEX, version: next }));
  writePackageVersion(version);
  const records = {
    codex: {
      source: "npm",
      spec,
      resolvedName: CODEX,
      resolvedSpec: `${CODEX}@${version}`,
      resolvedVersion: version,
      version,
      integrity: "sha512-old-codex",
      installPath: installDir,
    },
  };
  mocks.loadInstalledPluginIndexInstallRecords.mockResolvedValue(records);
  const snapshot = () => {
    const current = readFromDisk
      ? (JSON.parse(readText(packageFile)) as { version: string }).version
      : version;
    const plugin = { id: "codex", packageVersion: current, providers: ["codex"] };
    return { plugins: [plugin], diagnostics: [], byPluginId: new Map([["codex", plugin]]) };
  };
  if (readFromDisk) {
    mocks.loadPluginMetadataSnapshot.mockImplementation(snapshot);
  } else {
    mocks.loadPluginMetadataSnapshot.mockReturnValue(snapshot());
  }
  return { installDir, records, writePackageVersion };
}

async function useRealCapabilityConsent() {
  const actual = await vi.importActual<typeof import("../../../plugins/capability-consent.js")>(
    "../../../plugins/capability-consent.js",
  );
  prepareConsent.mockImplementation(actual.prepareManagedPluginArtifactConsentHandler);
}

describe("repairMissingConfiguredPluginInstalls", () => {
  it("propagates ambiguous managed repair ownership before commit or later repairs", async () => {
    await useRealCapabilityConsent();
    const { installPluginDirectoryIntoExtensions } =
      await import("../../../plugins/install-shared.js");
    const installDir = tempDirs.make("openclaw-doctor-ambiguous-owner-");
    const sourceDir = tempDirs.make("openclaw-doctor-ambiguous-source-");
    for (const rootDir of [installDir, sourceDir]) {
      createColdPluginFixture({ rootDir, pluginId: "demo", packageName: "@example/demo" });
    }
    fs.rmSync(path.join(installDir, "package.json"));
    const originalFiles = fileBytes(installDir);
    const record = { source: "npm" as const, spec: "@example/demo", installPath: installDir };
    const records = { demo: record, alias: { ...record } };
    const originalRecords = structuredClone(records);
    const cfg = pluginEntries("demo", "later");
    const originalConfig = structuredClone(cfg);
    mocks.loadInstalledPluginIndexInstallRecords.mockResolvedValue(records);
    metadata([], [], { plugins: [] });
    setChannels(
      channelPluginEntry({ id: "demo", npmSpec: "@example/demo" }),
      channelPluginEntry({ id: "later", npmSpec: "@example/later" }),
    );
    mocks.updateNpmInstalledPlugins.mockImplementation(
      async ({ config }: { config: OpenClawConfig }) => ({ config, changed: false, outcomes: [] }),
    );
    installNpm.mockImplementation(
      async (params: { onBeforePluginArtifactCommit: PluginInstallArtifactConsentHandler }) =>
        installPluginDirectoryIntoExtensions({
          sourceDir,
          targetDir: installDir,
          pluginId: "demo",
          extensions: ["index.cjs"],
          logger: {},
          timeoutMs: 1_000,
          mode: "update",
          dryRun: false,
          copyErrorPrefix: "failed to copy plugin",
          hasDeps: false,
          depsLogMessage: "Installing dependencies…",
          onBeforePluginArtifactCommit: params.onBeforePluginArtifactCommit,
        }),
    );
    const onCapabilityConsent = vi.fn<PluginCapabilityConsentHandler>();
    const beforePersistentEffect = vi.fn();
    const onWarning = vi.fn();

    await expect(
      repairInstalls({ cfg, env: testEnv, onCapabilityConsent, beforePersistentEffect, onWarning }),
    ).rejects.toMatchObject({
      name: "ManagedPluginLifecycleError",
      kind: "invalid-request",
      message: 'Plugin "demo" matches multiple installed package owners.',
      capabilityConsent: undefined,
    });

    expect(installNpm).toHaveBeenCalledOnce();
    notCalled(onCapabilityConsent, beforePersistentEffect, onWarning, persistRecords);
    expect(records).toEqual(originalRecords);
    expect(cfg).toEqual(originalConfig);
    expect(fs.readdirSync(installDir)).toEqual(originalFiles.map(({ file }) => file));
    expectFiles(installDir, originalFiles);
  });

  it.each(["accepted", "stale-descriptor"] as const)(
    "preserves a %s installed artifact when replacement capability consent is pending",
    async (previousState) => {
      await useRealCapabilityConsent();
      const installDir = tempDirs.make("openclaw-doctor-retained-consent-");
      const stageDir = tempDirs.make("openclaw-doctor-staged-consent-");
      for (const [rootDir, widened] of [
        [installDir, false],
        [stageDir, true],
      ] as const) {
        coldFixture(
          rootDir,
          "codex",
          CODEX,
          "2026.5.6",
          widened ? ["fixture.read", "fixture.write"] : ["fixture.read"],
        );
      }
      const records = installedRecords("codex", {
        spec: CODEX,
        resolvedSpec: "@openclaw/codex@2026.5.6",
        resolvedVersion: "2026.5.6",
        integrity: "sha512-previous",
        installPath: installDir,
        ...(previousState === "accepted"
          ? {
              acceptedSurface: resolvePluginArtifactDeclaredSurface(installDir),
              acceptedSurfaceHash: computeDeclaredSurfaceHash(
                resolvePluginArtifactDeclaredSurface(installDir),
              ),
              acceptedSurfaceAt: "2026-01-01T00:00:00.000Z",
              acceptedSurfaceIntegrity: "sha512-previous",
            }
          : {}),
      });
      const originalRecords = structuredClone(records);
      const originalFiles = fileBytes(installDir);
      mocks.loadInstalledPluginIndexInstallRecords.mockResolvedValue(records);
      metadata(
        [{ id: "codex", packageVersion: "2026.5.6", channels: ["codex"] }],
        previousState === "stale-descriptor"
          ? [{ level: "error", pluginId: "codex", message: "without channelConfigs metadata" }]
          : [],
        { plugins: [] },
      );
      setOfficial(officialPluginEntry({ id: "codex", npmSpec: CODEX }));
      let committed = false;
      installNpm.mockImplementation(
        async (params: { onBeforePluginArtifactCommit: PluginInstallArtifactConsentHandler }) => {
          await params.onBeforePluginArtifactCommit({
            pluginId: "codex",
            stagedArtifactDir: stageDir,
            mode: "update",
          });
          committed = true;
          return artifact("codex", CODEX, undefined, stageDir);
        },
      );
      const cfg: OpenClawConfig = configuredPlugin("codex");
      const result = await repairMissingPluginInstallsForIds({
        cfg,
        pluginIds: ["codex"],
        env: testEnv,
      });

      expect(committed).toBe(false);
      expect(result.records).toBe(records);
      expect(result.records).toEqual(originalRecords);
      expectFiles(installDir, originalFiles);
      expectRecordFields(result, {
        failedPluginIds: ["codex"],
        repairedPluginIds: undefined,
        pluginInventoryChanged: undefined,
      });
      expect(persistRecords).not.toHaveBeenCalled();
      expect(cfg.plugins?.entries?.codex?.enabled).toBe(true);
      const accepted = previousState === "accepted";
      const reviewNotice = [expect.stringContaining("--accept-capabilities")];
      expectRecordFields(result, {
        warnings: accepted ? [] : reviewNotice,
        notices: accepted ? reviewNotice : undefined,
        outcomes: accepted ? undefined : [consentFailure("codex")],
      });
    },
  );

  it("preserves refused repair records while a sibling succeeds", async () => {
    const records = npmRecords(
      "demo",
      "@example/demo",
      path.join(tempDirs.make("openclaw-doctor-missing-consent-"), "missing"),
      {
        resolvedSpec: "@example/demo@1.0.0",
        resolvedVersion: "1.0.0",
        integrity: "sha512-previous",
      },
    );
    const updatedSibling = {
      source: "npm",
      spec: "@example/sibling",
      version: "2.0.0",
      installPath: tempDirs.make("openclaw-doctor-sibling-"),
    };
    const refusal = {
      pluginId: "demo",
      status: "error",
      code: PLUGIN_CAPABILITY_CONSENT_REQUIRED,
      message: "Review replacement capabilities.",
    };
    records.sibling = { ...updatedSibling, version: "1.0.0" };
    mocks.loadInstalledPluginIndexInstallRecords.mockResolvedValue(records);
    mocks.updateNpmInstalledPlugins.mockImplementation(
      async ({ config }: { config: OpenClawConfig }) => ({
        config: {
          ...config,
          plugins: {
            ...config.plugins,
            installs: { ...config.plugins?.installs, sibling: updatedSibling },
          },
        },
        changed: true,
        outcomes: [
          { pluginId: "sibling", status: "updated", message: "Updated sibling." },
          refusal,
        ],
      }),
    );

    const result = await repairConfiguredPlugins(pluginEntries("demo", "sibling"));

    expect(result.records.demo).toBe(records.demo);
    expectRecordFields(result, {
      records: { ...records, sibling: updatedSibling },
      warnings: ["Review replacement capabilities."],
      outcomes: [refusal],
      notices: undefined,
    });
    expect(persistRecords).toHaveBeenCalledWith(result.records, expect.any(Object));
  });

  it("resolves an earlier consent refusal after repair without clearing another plugin's refusal", async () => {
    await useRealCapabilityConsent();
    const { preparePluginUpdateCapabilityConsent } =
      await import("../../../plugins/update-capability-consent.js");
    const { ManagedPluginLifecycleError } =
      await import("../../../plugins/management-lifecycle-error.js");
    const root = fs.realpathSync(tempDirs.make("openclaw-doctor-consent-order-"));
    pluginRoots(root);
    const pluginIds = ["demo", "other"];
    const records = Object.fromEntries(
      pluginIds.map((pluginId) => [
        pluginId,
        {
          source: "npm" as const,
          spec: "@example/" + pluginId + "@1.0.0",
          installPath: path.join(root, "installed", pluginId),
          integrity: "sha512-" + pluginId,
        },
      ]),
    );
    for (const pluginId of pluginIds) {
      const artifactDir = path.join(root, "staged", pluginId);
      coldFixture(artifactDir, pluginId, "@example/" + pluginId, undefined, [pluginId + ".write"]);
    }
    mocks.loadInstalledPluginIndexInstallRecords.mockResolvedValue(records);
    metadata([], [], { plugins: [], diagnostics: [], installRecords: records });
    setChannels(
      ...pluginIds.map((id) => channelPluginEntry({ id, npmSpec: "@example/" + id + "@1.0.0" })),
    );
    const reviewed: string[] = [];
    const onCapabilityConsent: PluginCapabilityConsentHandler = async (review) => {
      const accepted = review.pluginId === "demo" && reviewed.includes("demo");
      reviewed.push(review.pluginId);
      return accepted ? { reviewToken: review.reviewToken } : undefined;
    };
    // Keep the existing updater seam, but produce refusal through its real consent owner.
    const update: typeof import("../../../plugins/update.js").updateNpmInstalledPlugins = async (
      params,
    ) => {
      const outcomes: import("../../../plugins/update.js").PluginUpdateOutcome[] = [];
      for (const pluginId of params.pluginIds ?? []) {
        const record = expectDefined(
          params.config.plugins?.installs?.[pluginId],
          "missing install record",
        );
        const consent = preparePluginUpdateCapabilityConsent({
          config: params.config,
          pluginId,
          record,
          installPath: expectDefined(record.installPath, "recorded install path"),
          expectedIntegrity: record.integrity,
          onCapabilityConsent: params.onCapabilityConsent,
        });
        try {
          await consent.onBeforePluginArtifactCommit({
            pluginId,
            stagedArtifactDir: path.join(root, "staged", pluginId),
            mode: "update",
            sourceRecord: record,
          });
          throw new Error("The first repair attempt must require fresh consent.");
        } catch (error) {
          if (!(error instanceof ManagedPluginLifecycleError) || !error.capabilityConsent) {
            throw error;
          }
          outcomes.push({
            pluginId,
            status: "error",
            code: PLUGIN_CAPABILITY_CONSENT_REQUIRED,
            message: error.message,
          });
        }
      }
      return { config: params.config, changed: false, outcomes };
    };
    mocks.updateNpmInstalledPlugins.mockImplementation(update);
    const install: typeof import("../../../plugins/install.js").installPluginFromNpmSpec = async (
      params,
    ) => {
      const pluginId = expectDefined(params.expectedPluginId, "candidate plugin id");
      if (pluginId === "other") {
        return { ok: false, error: "Fixture installer failed for other." };
      }
      const artifactDir = path.join(root, "staged", pluginId);
      const record = expectDefined(records[pluginId], "fixture install record");
      await expectDefined(
        params.onBeforePluginArtifactCommit,
        "candidate consent hook",
      )({ pluginId, stagedArtifactDir: artifactDir, mode: "install", sourceRecord: record });
      const targetDir = record.installPath;
      fs.mkdirSync(path.dirname(targetDir), { recursive: true });
      fs.cpSync(artifactDir, targetDir, { recursive: true });
      return {
        ...artifact(pluginId, "@example/" + pluginId, "1.0.0", targetDir),
        extensions: ["index.cjs"],
      };
    };
    installNpm.mockImplementation(install);
    const repairModule = await import("./missing-configured-plugin-install.js");
    const repairSpy = vi.spyOn(repairModule, "repairMissingConfiguredPluginInstalls");
    try {
      const { runPostCorePluginConvergence } = await import("./post-core-plugin-convergence.js");
      const convergence = await runPostCorePluginConvergence({
        cfg: pluginEntries("demo", "other"),
        env: { OPENCLAW_STATE_DIR: path.join(root, "state") },
        baselineInstallRecords: records,
        onCapabilityConsent,
      });
      expect(reviewed).toEqual(["demo", "other", "demo"]);
      const invocation = expectDefined(repairSpy.mock.results[0], "real repair invocation");
      if (invocation.type !== "return") {
        throw new Error("Expected the real repair owner to return its result.");
      }
      const repair = await invocation.value;
      const demoRecord = expectDefined(repair.records.demo, "repaired demo record");
      expect(demoRecord).toMatchObject({
        spec: "@example/demo@1.0.0",
        acceptedSurface: { tools: ["demo.write"] },
      });
      expect(
        fs.existsSync(
          path.join(expectDefined(demoRecord.installPath, "repaired install path"), "package.json"),
        ),
      ).toBe(true);
      expect(repair.records.other).toBe(records.other);
      expect(repair.warnings).toContain(
        'Failed to install missing configured plugin "other" from @example/other@1.0.0: Fixture installer failed for other.',
      );
      expectRecordFields(repair, {
        repairedPluginIds: ["demo"],
        failedPluginIds: ["other"],
        outcomes: [consentFailure("other")],
      });
      const outcomes = convergence.outcomes ?? [];
      expect(outcomes.some((outcome) => outcome.pluginId === "demo")).toBe(false);
      expect(
        outcomes.filter((outcome) => outcome.code === PLUGIN_CAPABILITY_CONSENT_REQUIRED),
      ).toEqual([expect.objectContaining({ pluginId: "other" })]);
    } finally {
      repairSpy.mockRestore();
    }
  });

  it.each([
    { source: "npm", accepted: true },
    { source: "npm-retry", accepted: false },
    { source: "clawhub", accepted: false },
  ] as const)(
    "reviews doctor $source artifact capabilities through post-core convergence, accepted=$accepted",
    async ({ source, accepted }) => {
      await useRealCapabilityConsent();
      const root = tempDirs.make("openclaw-doctor-consent-");
      pluginRoots(root);
      const packageName = "@example/matrix";
      const artifactDir = path.join(root, "artifact");
      const fixture = coldFixture(artifactDir, "matrix", packageName, undefined, ["matrix.write"]);
      setChannels(
        catalogChannel(
          "matrix",
          source === "clawhub"
            ? { clawhubSpec: `clawhub:${packageName}@1.0.0` }
            : { npmSpec: `${packageName}@1.0.0`, defaultChoice: "npm" },
          "Matrix",
        ),
      );
      let committed = false;
      const install = async (params: {
        onBeforePluginArtifactCommit?: PluginInstallArtifactConsentHandler;
      }) => {
        await params.onBeforePluginArtifactCommit?.({
          pluginId: "matrix",
          stagedArtifactDir: artifactDir,
          mode: "install",
        });
        committed = true;
        return {
          ...artifact("matrix", packageName, "1.0.0", artifactDir),
          clawhub: { source: "clawhub", clawhubPackage: packageName, integrity: "sha256-matrix" },
        };
      };
      if (source === "npm-retry") {
        installNpm.mockResolvedValueOnce({
          ok: false,
          error: `plugin already exists: ${artifactDir}`,
        });
      }
      installNpm.mockImplementation(install);
      installClawHub.mockImplementation(install);
      const consent = acceptCapabilities();
      const cfg: OpenClawConfig = configuredPlugin("matrix");
      const result = await repairInstalls({
        cfg,
        env: testEnv,
        ...(accepted ? { onCapabilityConsent: consent } : {}),
      });

      expect(committed).toBe(accepted);
      expect(fs.existsSync(fixture.runtimeMarker)).toBe(false);
      if (accepted) {
        expect(consent).toHaveBeenCalledOnce();
        expectRecordFields(result, { outcomes: undefined, warnings: [] });
        expect(result.records.matrix).toMatchObject({
          acceptedSurface: { tools: ["matrix.write"] },
          acceptedSurfaceHash: expect.stringMatching(/^[a-f\d]{64}$/),
          acceptedSurfaceAt: expect.any(String),
        });
        expect(persistRecords).toHaveBeenCalledWith(result.records, expect.any(Object));
      } else {
        expectRecordFields(result, { records: {}, failedPluginIds: ["matrix"] });
        expect(result.warnings.join("\n")).toMatch(/capabilit/i);
        expect(result.outcomes).toEqual([consentFailure("matrix")]);
        expect(persistRecords).not.toHaveBeenCalled();
      }

      const { runPostCorePluginConvergence } = await import("./post-core-plugin-convergence.js");
      const convergence = await runPostCorePluginConvergence({
        cfg,
        env: { OPENCLAW_STATE_DIR: path.join(root, "state") },
        baselineInstallRecords: {},
        ...(accepted ? { onCapabilityConsent: consent } : {}),
      });
      expect(convergence.smokeFailures).toEqual([]);
      if (!accepted) {
        expect(convergence.installRecords).toEqual({});
      }
      expect(convergence.outcomes ?? []).toEqual(accepted ? [] : [consentFailure("matrix")]);
    },
  );

  setupPluginInstallSuite();

  it("fences baseline persistence when authority is revoked after the async callback returns", async () => {
    const root = tempDirs.make("openclaw-doctor-index-fence-");
    const env = { ...testEnv, OPENCLAW_STATE_DIR: path.join(root, "state") };
    const cfg = { plugins: { enabled: false } } satisfies OpenClawConfig;
    await useRealInstallIndexWrites();
    const records = { retained: { source: "npm" as const, spec: "retained@1.0.0" } };
    const baselineRecords = { replacement: { source: "npm" as const, spec: "replacement@2.0.0" } };
    try {
      await seedInstalledPluginIndex(records, { env, config: cfg, candidates: [] });
      const before = await readIndex({ env });
      let current = true;
      const failure = new Error("update authority revoked after planning");
      const beforePersistentEffect = vi.fn(async () => {
        // Returning a fulfilled promise still yields before the owner's next statement.
        queueMicrotask(() => {
          current = false;
        });
      });
      await expect(
        withPluginLifecycleLease(
          {
            env,
            assertCurrent: () => {
              if (!current) {
                throw failure;
              }
            },
          },
          () =>
            repairMissingPluginInstallsForIds({
              cfg,
              pluginIds: [],
              env,
              baselineRecords,
              beforePersistentEffect,
            }),
        ),
      ).rejects.toBe(failure);
      expect(beforePersistentEffect).toHaveBeenCalledOnce();
      expect(current).toBe(false);
      expect(await readIndex({ env })).toEqual(before);
      expect(before?.installRecords).toEqual(records);
    } finally {
      await closeDatabase(statePath(env));
    }
  });

  it("retries the operator ClawHub selector when no beta release is published", async () => {
    const cfg = {
      security: { installPolicy: { enabled: true } },
      update: { channel: "beta" },
      channels: { matrix: { enabled: true, homeserver: "https://matrix.example.org" } },
    } satisfies OpenClawConfig;
    installClawHub.mockResolvedValueOnce({
      ok: false,
      code: "version_not_found",
      error: "Version not found on ClawHub: @openclaw/plugin-matrix@beta.",
    });
    setChannels(
      catalogChannel("matrix", { clawhubSpec: "clawhub:@openclaw/plugin-matrix" }, "Matrix"),
    );

    const result = await repairInstalls({ cfg, env: testEnv });

    expect(mockCallArg(installClawHub, 0)).toMatchObject({
      spec: "clawhub:@openclaw/plugin-matrix@beta",
    });
    expect(mockCallArg(installClawHub, 1)).toMatchObject({
      spec: "clawhub:@openclaw/plugin-matrix",
    });
    expect(result.notices).toEqual(
      expect.arrayContaining([
        expect.stringContaining("No clawhub:@openclaw/plugin-matrix@beta release is published"),
      ]),
    );
  });

  it("preserves ClawHub-only install metadata and review notices", async () => {
    const cfg = {
      security: { installPolicy: { enabled: true } },
      channels: { matrix: { enabled: true, homeserver: "https://matrix.example.org" } },
    } satisfies OpenClawConfig;
    const reviewNotice =
      "╭─ REVIEW RECOMMENDED - ClawHub has not completed a fresh clean check ─╮\n" +
      "│ • Status:            security scan is pending                         │\n" +
      "╰───────────────────────────────────────────────────────────────────────╯";
    const coloredReviewNotice = `\u001b[33m${reviewNotice}\u001b[39m`;
    const install = expectDefined(
      installClawHub.getMockImplementation(),
      "default ClawHub artifact",
    );
    installClawHub.mockImplementationOnce(
      async (params: { logger?: { warn?: (message: string) => void } }) => {
        params.logger?.warn?.(coloredReviewNotice);
        return install(params);
      },
    );
    setChannels(
      catalogChannel("matrix", { clawhubSpec: "clawhub:@openclaw/plugin-matrix@stable" }, "Matrix"),
    );

    const result = await repairInstalls({
      cfg,
      env: { ...testEnv, OPENCLAW_UPDATE_IN_PROGRESS: "1" },
    });

    const clawHubCall = expectRecordFields(mockCallArg(installClawHub), {
      spec: expectedClawHubInstallSpec("clawhub:@openclaw/plugin-matrix@stable"),
      expectedPluginId: "matrix",
      config: cfg,
    });
    expect(clawHubCall.logger).toEqual(expect.objectContaining({ terminalLinks: false }));
    expect(installNpm).not.toHaveBeenCalled();
    expect(result.changes).toEqual([
      installedMessage("matrix", "clawhub:@openclaw/plugin-matrix@stable"),
    ]);
    expect(result.notices).toContain(reviewNotice);
    expect(result.notices?.[0]).not.toContain("\u001b");
    expect(result.warnings).toStrictEqual([]);
  });

  it("adds repair warnings for blocked ClawHub update outcomes", async () => {
    const records = {
      demo: {
        source: "clawhub",
        spec: "clawhub:@openclaw/plugin-demo@stable",
        clawhubPackage: "@openclaw/plugin-demo",
        installPath: "/missing/demo",
      },
    };
    mocks.loadInstalledPluginIndexInstallRecords.mockResolvedValue(records);
    mocks.updateNpmInstalledPlugins.mockResolvedValueOnce({
      changed: false,
      config: { plugins: { installs: records } },
      outcomes: [
        {
          pluginId: "demo",
          status: "skipped",
          code: "clawhub_download_blocked",
          message:
            'Skipped demo ClawHub update: ClawHub release "@openclaw/plugin-demo@1.2.4" cannot be installed because ClawHub flagged it as blocked or malicious. Review the security details above or choose a different version. Existing installed plugin left unchanged.',
        },
      ],
    });

    const result = await repairMissingConfiguredPluginInstalls({
      cfg: configuredPlugin("demo"),
      env: testEnv,
    });

    expect(mocks.updateNpmInstalledPlugins).toHaveBeenCalledWith(
      expect.objectContaining({ pluginIds: ["demo"] }),
    );
    expect(result.changes).toStrictEqual([]);
    expect(result.warnings).toStrictEqual([
      'Skipped demo ClawHub update: ClawHub release "@openclaw/plugin-demo@1.2.4" cannot be installed because ClawHub flagged it as blocked or malicious. Review the security details above or choose a different version. Existing installed plugin left unchanged.',
    ]);
  });

  it("installs a missing channel plugin selected by environment config from npm", async () => {
    installNpm.mockResolvedValueOnce(artifact("matrix", MATRIX, "1.2.3"));
    setChannels({
      ...catalogChannel("matrix", { npmSpec: `${MATRIX}@1.2.3` }, "Matrix"),
      trustedSourceLinkedOfficialInstall: true,
    });

    const result = await repairInstalls({
      cfg: {},
      env: { ...testEnv, MATRIX_HOMESERVER: "https://matrix.example.org" },
    });

    expect(installClawHub).not.toHaveBeenCalled();
    expectRecordFields(mockCallArg(installNpm), {
      spec: "@openclaw/plugin-matrix@1.2.3",
      extensionsDir: "/tmp/openclaw-plugins",
      expectedPluginId: "matrix",
      trustedSourceLinkedOfficialInstall: true,
    });
    const records = mockCallArg(persistRecords);
    expectRecordFields((records as Record<string, unknown>).matrix, {
      source: "npm",
      spec: "@openclaw/plugin-matrix@1.2.3",
      installPath: "/tmp/openclaw-plugins/matrix",
    });
    expect(mockCallArg(persistRecords, 0, 1)).toEqual(
      expectedIndexWriteOptions(
        {},
        { ...testEnv, MATRIX_HOMESERVER: "https://matrix.example.org" },
      ),
    );
    expect(result.changes).toEqual([installedMessage("matrix", "@openclaw/plugin-matrix@1.2.3")]);
    expect(result.warnings).toStrictEqual([]);
  });

  it.each([
    { installed: false, expectedVersion: "2026.9.3" },
    { installed: true, expectedVersion: "2026.8.1" },
  ])(
    "preserves the selected release while repairing official plugins (installed=$installed)",
    async ({ installed, expectedVersion }) => {
      const pluginId = "duckduckgo";
      const packageName = "@openclaw/duckduckgo-plugin";
      const coreVersion = "2026.9.3";
      const latestVersion = "2026.9.4";
      const config: OpenClawConfig = {
        update: { channel: "stable" },
        ...configuredPlugin(pluginId),
      };
      const env = { ...testEnv, OPENCLAW_COMPATIBILITY_HOST_VERSION: coreVersion };
      const installPath = tempDirs.make("openclaw-doctor-pinned-duckduckgo-");
      const records = installed
        ? installedRecords(pluginId, {
            spec: `${packageName}@2026.8.1`,
            resolvedVersion: "2026.8.1",
            installPath,
          })
        : {};
      if (installed) {
        coldFixture(installPath, pluginId, packageName, "2026.8.1");
        metadata([
          {
            id: pluginId,
            origin: "global",
            packageName,
            rootDir: installPath,
            source: path.join(installPath, "index.cjs"),
            channels: [],
          },
        ]);
      }
      mocks.loadInstalledPluginIndexInstallRecords.mockResolvedValue(records);
      setOfficial(
        officialPluginEntry({
          id: pluginId,
          npmSpec: packageName,
          overrides: { name: packageName, source: "official" },
        }),
      );
      const versionForSpec = (spec: string) =>
        spec === packageName ? latestVersion : spec.slice(packageName.length + 1);
      mocks.resolveNpmSpecMetadata.mockImplementation(async ({ spec }: { spec: string }) => ({
        ok: true,
        metadata: {
          name: packageName,
          version: versionForSpec(spec),
          resolvedSpec: `${packageName}@${versionForSpec(spec)}`,
        },
      }));
      installNpm.mockImplementation(async ({ spec }: { spec: string }) =>
        successfulInstall({ pluginId, npmSpec: packageName, version: versionForSpec(spec) }),
      );
      const targets = await collectConfiguredNpmPluginTargets({
        config,
        env,
        targetVersion: coreVersion,
        channel: "stable",
      });
      const expectedSpec = `${packageName}@${expectedVersion}`;
      const { resolveNpmInstallSpecsForUpdateChannel } =
        await import("../../../plugins/install-channel-specs.js");
      expect(await Promise.all(targets.map(resolveNpmInstallSpecsForUpdateChannel))).toEqual([
        expect.objectContaining({ installSpec: expectedSpec }),
      ]);
      notCalled(installNpm, persistRecords);

      const result = await repairConfiguredPlugins(config, env);
      expect(result.warnings).toEqual([]);
      if (installed) {
        expect(result.records).toEqual(records);
        notCalled(installNpm, persistRecords);
      } else {
        expectRecordFields(mockCallArg(installNpm), {
          spec: expectedSpec,
          expectedPluginId: pluginId,
        });
        expectRecordFields(result.records[pluginId], {
          spec: packageName,
          resolvedVersion: expectedVersion,
          resolvedSpec: `${packageName}@${expectedVersion}`,
        });
        expect(persistRecords).toHaveBeenCalledWith(
          result.records,
          expectedIndexWriteOptions(config, env),
        );
      }
    },
  );

  it.each([
    [
      "channel metadata",
      {
        channels: {
          modelByChannel: { matrix: { default: "openai/gpt-5.6-luna" } },
          " ": { homeserver: "https://matrix.example.org" },
        },
      },
    ],
    [
      "matching disabled plugin entry",
      {
        plugins: { entries: { matrix: { enabled: false } } },
        channels: { matrix: { homeserver: "https://matrix.example.org" } },
      },
    ],
  ])("does not install channel plugins for a %s", async (_label, cfg) => {
    setChannels(catalogChannel("matrix", { npmSpec: "@openclaw/plugin-matrix@1.2.3" }, "Matrix"));

    const result = await repairInstalls({ cfg, env: testEnv });

    notCalled(installClawHub, installNpm, persistRecords);
    expect(result).toEqual({ changes: [], warnings: [], records: {} });
  });

  it("removes stale managed install records when the configured plugin is bundled", async () => {
    const sourceRoot = tempDirs.make("openclaw-bundled-record-retirement-");
    writeStub(sourceRoot, "openclaw");
    fs.mkdirSync(path.join(sourceRoot, "src"));
    fs.mkdirSync(path.join(sourceRoot, "extensions"));
    const bundledRoot = path.join(sourceRoot, "dist", "extensions", "bundleddemo");
    fs.mkdirSync(bundledRoot, { recursive: true });
    const env = { ...testEnv, OPENCLAW_DEV_SOURCE_ROOT: sourceRoot };
    const records = {
      bundleddemo: { source: "npm", spec: BUNDLED, installPath: "/missing/bundleddemo" },
    };
    mocks.loadInstalledPluginIndexInstallRecords.mockResolvedValue(records);
    const cfg = bundledDemo(bundledRoot);

    const result = await repairInstalls({ cfg, env });

    notCalled(mocks.updateNpmInstalledPlugins, installClawHub, installNpm);
    expect(persistRecords).toHaveBeenCalledWith(
      {},
      expectedIndexWriteOptions(expect.any(Object), env),
    );
    expect(result).toEqual({
      changes: ['Removed stale managed install record for bundled plugin "bundleddemo".'],
      warnings: [],
      pluginInventoryChanged: true,
      records: {},
    });
  });

  it("repairs a hollow official external install in a source checkout", async () => {
    const root = tempDirs.make("openclaw-external-companion-");
    const installPath = path.join(root, "payload");
    const repairedPath = path.join(root, "repaired");
    writeStub(repairedPath, "@openclaw/google-meet");
    fs.mkdirSync(installPath);

    const records = npmRecords("google-meet", "@openclaw/google-meet", installPath, {
      resolvedName: "@openclaw/google-meet",
    });
    mocks.loadInstalledPluginIndexInstallRecords.mockResolvedValue(records);
    const repairedRecords = {
      "google-meet": { ...records["google-meet"], installPath: repairedPath },
    };
    mocks.updateNpmInstalledPlugins.mockResolvedValue(
      successfulUpdate("google-meet", repairedRecords),
    );
    metadata([{ id: "google-meet", origin: "npm", packageName: "@openclaw/google-meet" }], []);
    mockCurrentBundledPlugin("google-meet", "@openclaw/google-meet");
    setOfficial({
      id: "google-meet",
      label: "Google Meet",
      install: { npmSpec: "@openclaw/google-meet" },
      openclaw: { id: "google-meet", install: { npmSpec: "@openclaw/google-meet" } },
    });

    const result = await repairInstalls({ cfg: configuredPlugin("google-meet"), env: testEnv });

    expect(installNpm).not.toHaveBeenCalled();
    expect(mocks.updateNpmInstalledPlugins).toHaveBeenCalledOnce();
    expectRecordFields(result, {
      records: repairedRecords,
      changes: ['Repaired missing configured plugin "google-meet".'],
      warnings: [],
      outcomes: undefined,
    });
  });

  it("keeps clawhub install records whose package names only share a bundled prefix", async () => {
    const record = {
      source: "clawhub",
      spec: "clawhub:@openclaw/bundleddemo-fork@stable",
      clawhubPackage: "@openclaw/bundleddemo-fork",
      installPath: "/missing/bundleddemo-fork",
    };

    const records = { bundleddemo: record };
    mocks.loadInstalledPluginIndexInstallRecords.mockResolvedValue(records);
    const cfg = bundledDemo();

    const result = await repairInstalls({ cfg, env: testEnv });

    notCalled(mocks.updateNpmInstalledPlugins, installClawHub, installNpm, persistRecords);
    expect(result).toEqual({ changes: [], warnings: [], records });
  });

  it.each(["legacy", "project"] as const)(
    "converges orphaned %s npm payloads to the verified stable target",
    async (layout) => {
      const channel = "stable";
      const coreVersion = "2026.8.2";
      const version = coreVersion;
      const npmSpec = CODEX;
      mockNpmRegistryTags({ beta: version, latest: "2026.7.9" });
      await useRealCapabilityConsent();
      useManifestCatalogResolvers();
      const root = tempDirs.make("openclaw-orphaned-plugin-repair-");
      const npmRoot = pluginRoots(root);
      const packageName = CODEX;
      const packageDir =
        layout === "legacy"
          ? path.join(npmRoot, "node_modules", ...packageName.split("/"))
          : mocks.resolvePluginNpmPackageDir({ npmDir: npmRoot, packageName });
      const stageDir = path.join(root, "verified-artifact");
      const fixtures = (
        [
          [packageDir, "2026.7.1"],
          [stageDir, version],
        ] as const
      ).map(([rootDir, packageVersion]) => {
        return coldFixture(rootDir, "codex", packageName, packageVersion, ["fixture.read"]);
      });
      setOfficial(officialPluginEntry({ id: "codex", npmSpec }));
      const integrity = "sha512-verified-codex";
      installNpm.mockImplementation(
        async (params: {
          spec: string;
          onBeforePluginArtifactCommit: PluginInstallArtifactConsentHandler;
        }) => {
          await params.onBeforePluginArtifactCommit({
            pluginId: "codex",
            stagedArtifactDir: stageDir,
            mode: "update",
            sourceRecord: {
              source: "npm",
              spec: params.spec,
              resolvedName: packageName,
              resolvedVersion: version,
              resolvedSpec: `${packageName}@${version}`,
              integrity,
            },
          });
          return artifact("codex", packageName, version, stageDir, { integrity });
        },
      );
      const consent = acceptCapabilities();
      const result = await repairInstalls({
        cfg: { update: { channel }, ...configuredPlugin("codex") },
        env: {
          ...testEnv,
          OPENCLAW_UPDATE_POST_CORE_CONVERGENCE: "1",
          OPENCLAW_COMPATIBILITY_HOST_VERSION: coreVersion,
        },
        onCapabilityConsent: consent,
      });

      expect(result.records.codex).toMatchObject({
        source: "npm",
        spec: npmSpec,
        installPath: stageDir,
        version,
        resolvedVersion: version,
        resolvedSpec: `${packageName}@${version}`,
        integrity,
      });
      expect(result.records.codex?.sourcePath).toBeUndefined();
      expect(result.records.codex?.acceptedSurface).toBeUndefined();
      expect(
        isTrustedOfficialPluginInstallRecord({
          pluginId: "codex",
          packageName,
          record: expectDefined(result.records.codex, "verified install record"),
        }),
      ).toBe(true);
      expect(installNpm).toHaveBeenCalledOnce();
      expectRecordFields(mockCallArg(installNpm), {
        spec: `${packageName}@${version}`,
        mode: "update",
        trustedSourceLinkedOfficialInstall: true,
      });
      notCalled(installClawHub, consent);
      expect(result.warnings).toEqual([]);
      expect(fixtures.every((fixture) => !fs.existsSync(fixture.runtimeMarker))).toBe(true);
    },
  );

  it("defers recorded channel-selected package repair during updates", async () => {
    const records = npmRecords("discord", "@openclaw/discord", "/missing/discord");
    mocks.loadInstalledPluginIndexInstallRecords.mockResolvedValue(records);
    setChannels(catalogChannel("discord", { npmSpec: "@openclaw/discord" }, "Discord"));
    const result = await repairConfiguredPlugins(
      { channels: { discord: { enabled: true, token: "secret" } } },
      {
        OPENCLAW_UPDATE_IN_PROGRESS: "1",
        OPENCLAW_UPDATE_DEFER_CONFIGURED_PLUGIN_INSTALL_REPAIR: "1",
      },
    );
    const detail =
      'Skipped package-manager repair for configured plugin "discord" during package update; rerun "openclaw doctor --fix" after the update completes.';
    notCalled(mocks.updateNpmInstalledPlugins, installClawHub, installNpm, persistRecords);
    expect(result).toEqual({
      changes: [detail],
      warnings: [],
      records,
      deferredRepairDetails: [detail],
    });
  });

  it("does not install configured plugins when plugins are globally disabled", async () => {
    const records = {
      brave: { source: "npm" as const, spec: BRAVE, installPath: "/tmp/openclaw-plugins/brave" },
      discord: {
        source: "npm" as const,
        spec: "@openclaw/discord",
        installPath: "/tmp/openclaw-plugins/discord",
      },
    };
    mocks.loadInstalledPluginIndexInstallRecords.mockResolvedValue(records);
    mocks.loadPluginMetadataSnapshot.mockReturnValue({
      plugins: [],
      diagnostics: [
        ...brokenPluginSnapshot("brave", records.brave.installPath).diagnostics,
        ...brokenPluginSnapshot("discord", records.discord.installPath).diagnostics,
      ],
    });
    mocks.updateNpmInstalledPlugins.mockResolvedValue({
      changed: false,
      config: { plugins: { installs: records } },
      outcomes: [
        { pluginId: "brave", status: "skipped", message: "disabled" },
        { pluginId: "discord", status: "skipped", message: "disabled" },
      ],
    });
    setChannels(catalogChannel("matrix", { npmSpec: "@openclaw/plugin-matrix@1.2.3" }, "Matrix"));
    setOfficial(
      { id: "codex", label: "Codex", install: { npmSpec: CODEX, defaultChoice: "npm" } },
      {
        id: "diagnostics-otel",
        label: "Diagnostics OpenTelemetry",
        install: { npmSpec: "@openclaw/diagnostics-otel", defaultChoice: "npm" },
      },
    );

    const cfg: OpenClawConfigWithLegacyRoster = {
      plugins: { enabled: false, entries: { "diagnostics-otel": { enabled: true } } },
      channels: { matrix: { homeserver: "https://matrix.example.org" } },
      agents: { defaults: { agentRuntime: { id: "codex" } } },
    };
    const result = await repairInstalls({ cfg, env: testEnv });

    expect(mocks.updateNpmInstalledPlugins).toHaveBeenCalledWith(
      expect.objectContaining({ pluginIds: ["brave", "discord"], skipDisabledPlugins: true }),
    );
    notCalled(installClawHub, installNpm);
    expect(result).toEqual({ changes: [], warnings: [], records });
  });

  it("installs a selected runtime from its built-in fallback when no catalog entry exists", async () => {
    installNpm.mockResolvedValueOnce(artifact("codex", CODEX, VERSION));
    const result = await repairConfiguredPlugins({
      agents: { defaults: { model: "openai/gpt-5.5" } },
    });
    expect(installNpm).toHaveBeenCalledWith(
      expect.objectContaining({ expectedPluginId: "codex", spec: expectedCodexInstallSpec() }),
    );
    expect(result.records.codex).toMatchObject({ spec: CODEX, version: VERSION });
    expect(result.warnings).toEqual([]);
  });

  it.each(["disabled", "bundled"] as const)(
    "does not select npm targets for a %s configured plugin",
    async (kind) => {
      const records = npmRecords("fixture", "@example/fixture@1.0.0", process.cwd(), {
        source: "npm",
      });
      mocks.loadInstalledPluginIndexInstallRecords.mockResolvedValue(records);
      metadata([{ id: "fixture", channels: [] }], []);
      if (kind === "bundled") {
        mockCurrentBundledPlugin("fixture", "@example/fixture");
      }
      await expect(
        collectConfiguredNpmPluginTargets({
          config: { plugins: { entries: { fixture: { enabled: kind !== "disabled" } } } },
          env: testEnv,
          targetVersion: "2026.9.3",
          channel: "stable",
        }),
      ).resolves.toEqual([]);
      notCalled(mocks.resolveNpmSpecMetadata, installNpm, persistRecords);
    },
  );

  it("preserves exact npm selector intent when refreshing a stale Codex runtime plugin", async () => {
    const priorSpec = "@openclaw/codex@2026.5.6";
    const expectedSpec = `@openclaw/codex@${VERSION}`;
    const expectedIntegrity = "sha512-new-codex";
    const installedVersion = "2026.5.6";
    const coreVersion = VERSION;

    installedCodex(installedVersion, priorSpec);
    installNpm.mockResolvedValueOnce(
      artifact("codex", CODEX, coreVersion, undefined, { integrity: "sha512-new-codex" }),
    );
    setOfficial({
      id: "codex",
      label: "Codex",
      install: { npmSpec: CODEX, defaultChoice: "npm", expectedIntegrity },
    });

    const result = await repairInstalls({
      cfg: { agents: { defaults: { model: "openai/gpt-5.5" } } },
      env: { ...testEnv, OPENCLAW_COMPATIBILITY_HOST_VERSION: coreVersion },
    });

    expect(mocks.resolveDirectBundledProviderPolicySurface).toHaveBeenCalledWith("openai");
    expect(mocks.updateNpmInstalledPlugins).not.toHaveBeenCalled();
    expectRecordFields(mockCallArg(installNpm), {
      spec: `@openclaw/codex@${coreVersion}`,
      expectedPluginId: "codex",
      trustedSourceLinkedOfficialInstall: true,
      mode: "update",
      expectedIntegrity,
    });
    expect(prepareConsent).toHaveBeenCalledWith(
      expect.objectContaining({
        source: "npm",
        spec: `@openclaw/codex@${coreVersion}`,
        expectedIntegrity,
      }),
    );
    expect(installClawHub).not.toHaveBeenCalled();
    expect(result.changes).toEqual([refreshedMessage("codex", `${CODEX}@${coreVersion}`)]);
    expectRecordFields(result.records.codex, {
      source: "npm",
      spec: expectedSpec,
      installPath: "/tmp/openclaw-plugins/codex",
      version: coreVersion,
      resolvedName: CODEX,
      resolvedVersion: coreVersion,
      resolvedSpec: `@openclaw/codex@${coreVersion}`,
      integrity: "sha512-new-codex",
    });
  });

  it.each(
    // prettier-ignore
    [
    ["stale beta follows newer latest", "2026.9.1-beta.1", "2026.9.1-beta.1", "2026.9.2", "2026.9.2", true, undefined],
    ["already-current beta older than the host is a no-op", "2026.9.1-beta.1", "2026.9.1-beta.1", "2026.8.31", "2026.9.1-beta.1", false, undefined],
    ["registry outage retains a healthy installed beta", "2026.9.1-beta.1", "2026.9.1-beta.1", "2026.9.2", "2026.9.2", false, true],
  ] as const,
  )(
    "converges managed Codex startup: %s",
    async (
      _name,
      installedVersion,
      betaVersion,
      latestVersion,
      selectedVersion,
      refresh,
      registryUnavailable: boolean | undefined = false,
    ) => {
      mockNpmRegistryTags({ beta: betaVersion, latest: latestVersion });
      if (registryUnavailable) {
        mocks.resolveNpmSpecMetadata.mockResolvedValue({
          ok: false,
          category: "metadata-env",
          error: "registry unavailable",
        });
      }
      const { installDir, records, writePackageVersion } = installedCodex(
        installedVersion,
        CODEX,
        true,
      );
      installNpm.mockImplementation(async () => {
        writePackageVersion(selectedVersion);
        return artifact("codex", CODEX, selectedVersion, installDir);
      });
      setOfficial(officialPluginEntry({ id: "codex", npmSpec: CODEX }));
      const params = {
        cfg: {
          update: { channel: "beta" as const },
          agents: { defaults: { model: "openai/gpt-5.5" } },
        },
        env: { ...testEnv, OPENCLAW_COMPATIBILITY_HOST_VERSION: "2026.9.2" },
      };
      const firstPass = await repairInstalls(params);

      if (refresh) {
        expect(installNpm).toHaveBeenCalledOnce();
        expectRecordFields(mockCallArg(installNpm), {
          spec: `@openclaw/codex@${selectedVersion}`,
          expectedPluginId: "codex",
          trustedSourceLinkedOfficialInstall: true,
          mode: "update",
        });
        expectRecordFields(firstPass, {
          changes: [refreshedMessage("codex", `${CODEX}@${selectedVersion}`)],
          pluginInventoryChanged: true,
        });
        expect(firstPass.notices).toContain(
          `Plugin "codex" refresh: newer-available (${installedVersion} -> ${selectedVersion}).`,
        );
        if (selectedVersion === latestVersion) {
          expect(firstPass.notices).toContain(
            `Plugin "codex" refresh: tag-behind-latest; beta follows latest ${selectedVersion}.`,
          );
        }
        expectRecordFields(firstPass.records.codex, {
          source: "npm",
          spec: CODEX,
          installPath: installDir,
          version: selectedVersion,
          resolvedVersion: selectedVersion,
          resolvedSpec: `@openclaw/codex@${selectedVersion}`,
        });
      } else {
        notCalled(installNpm, persistRecords);
        expect(firstPass.records).toBe(records);
        expectRecordFields(firstPass, {
          changes: [],
          pluginInventoryChanged: undefined,
          repairedPluginIds: undefined,
        });
        if (registryUnavailable) {
          expect(firstPass.notices ?? []).toEqual([
            expect.stringContaining('Kept installed plugin "codex"; replacement deferred.'),
          ]);
        } else {
          expect(firstPass.notices).toContain(
            `Plugin "codex" refresh: already-current (${installedVersion}).`,
          );
        }
      }
      expect(firstPass.warnings).toEqual([]);
      installNpm.mockClear();
      persistRecords.mockClear();
      mocks.loadInstalledPluginIndexInstallRecords.mockResolvedValue(firstPass.records);

      const secondPass = await repairInstalls(params);

      notCalled(installNpm, persistRecords);
      expectRecordFields(secondPass, { changes: [], warnings: firstPass.warnings });
      if (registryUnavailable) {
        expect(secondPass.notices).toEqual(firstPass.notices);
      }
      expect(secondPass.records).toBe(firstPass.records);
      expectRecordFields(secondPass, {
        pluginInventoryChanged: undefined,
        repairedPluginIds: undefined,
      });
    },
  );

  it("does not install a blocked downloadable plugin from explicit channel ids", async () => {
    setChannels(catalogChannel("matrix", { npmSpec: "@openclaw/plugin-matrix@1.2.3" }, "Matrix"));

    const result = await repairMissingPluginInstallsForIds({
      cfg: {},
      pluginIds: [],
      channelIds: ["matrix"],
      blockedPluginIds: ["matrix"],
      env: testEnv,
    });

    notCalled(installClawHub, installNpm);
    expect(result).toEqual({ changes: [], warnings: [], records: {} });
  });

  it("does not install a channel catalog plugin when a configured plugin already owns that channel", async () => {
    mocks.loadPluginMetadataSnapshot.mockReturnValue({
      plugins: [
        {
          id: "openclaw-lark",
          origin: "config",
          channels: ["feishu"],
          channelConfigs: { feishu: { schema: { type: "object" } } },
        },
      ],
      diagnostics: [],
    });
    setChannels({
      ...catalogChannel("feishu", { npmSpec: "@openclaw/feishu" }, "Feishu"),
      trustedSourceLinkedOfficialInstall: true,
    });
    const result = await repairInstalls({
      cfg: {
        plugins: { entries: { "openclaw-lark": { enabled: true } } },
        channels: { feishu: { footer: { model: false } } },
      },
      env: testEnv,
    });

    notCalled(installClawHub, installNpm, persistRecords);
    expect(result).toEqual({ changes: [], warnings: [], records: {} });
  });

  it.each(["npm", "clawhub"] as const)(
    "preserves %s updater warnings at the correct severity",
    async (source) => {
      const notice = source === "clawhub";
      const spec = notice ? "clawhub:@openclaw/plugin-demo@1.0.0" : "@openclaw/plugin-demo@1.0.0";
      const record = {
        source,
        spec,
        installPath: "/missing/demo",
        ...(notice ? { clawhubPackage: "@openclaw/plugin-demo" } : {}),
      };
      const message = notice
        ? "╭─ ClawHub Security Audit ────────────────────────────────╮\n" +
          "│ Outcome: Review                                        │\n" +
          "╰───────────────────────────────────────────────────────────────────────╯"
        : 'Could not repair openclaw peer link for "demo" at /tmp/openclaw-plugins/demo: permission denied';
      mocks.loadInstalledPluginIndexInstallRecords.mockResolvedValue({ demo: record });
      mocks.updateNpmInstalledPlugins.mockImplementationOnce(
        async (params: { logger?: { warn?: (message: string) => void } }) => {
          params.logger?.warn?.(notice ? `\u001b[33m${message}\u001b[39m` : message);
          return successfulUpdate("demo", {
            demo: { source, spec, installPath: "/tmp/openclaw-plugins/demo" },
          });
        },
      );
      const onWarning = vi.fn();
      const result = await repairInstalls({
        cfg: configuredPlugin("demo"),
        env: testEnv,
        onWarning,
      });
      if (notice) {
        expect(result.notices).toContain(message);
        expect(result.notices?.[0]).not.toContain("\u001b");
        expect(result.warnings).toEqual([]);
        expect(onWarning).not.toHaveBeenCalled();
      } else {
        expect(onWarning).toHaveBeenCalledWith({ message });
        expect(result.warnings).toContain(message);
        expect(result.notices ?? []).not.toContain(message);
      }
    },
  );

  it("replaces a configured official channel plugin when only its channel is configured", async () => {
    const pluginId = "slack";
    const npmSpec = "@openclaw/slack";
    const priorSpec = "@openclaw/slack@2026.5.12-beta.1";
    const targetDir = "/tmp/openclaw-npm/node_modules/@openclaw/slack";
    const cfg = { channels: { slack: { enabled: true, botToken: "xoxb-test" } } };

    const extensionsDir = path.join(tempDirs.make("openclaw-plugin-stub-repair-"), "extensions");
    const installDir = path.join(extensionsDir, pluginId);
    mocks.resolveDefaultPluginExtensionsDir.mockReturnValue(extensionsDir);
    writeStub(installDir, pluginId);
    const records = npmRecords(pluginId, priorSpec, installDir, {
      source: "npm",
      clawhubPackage: npmSpec,
      clawhubChannel: "official",
      clawhubUrl: "https://clawhub.ai",
    });
    mocks.loadInstalledPluginIndexInstallRecords.mockResolvedValue(records);
    mocks.loadPluginMetadataSnapshot.mockReturnValue(brokenPluginSnapshot(pluginId, installDir));
    setChannels(
      channelPluginEntry({
        id: pluginId,
        npmSpec,
        label: "Slack",
        trustedSourceLinkedOfficialInstall: true,
      }),
    );
    installNpm.mockResolvedValueOnce(
      successfulInstall({ pluginId, npmSpec, version: "2026.5.12", targetDir }),
    );

    const result = await repairConfiguredPlugins(cfg);

    expect(mocks.updateNpmInstalledPlugins).not.toHaveBeenCalled();
    expect(fs.existsSync(installDir)).toBe(false);
    expectRecordFields(mockCallArg(installNpm), {
      spec: priorSpec,
      expectedPluginId: pluginId,
      trustedSourceLinkedOfficialInstall: true,
      mode: "update",
    });
    const persistedRecords = mockCallArg(persistRecords) as Record<string, unknown>;
    expectRecordFields(persistedRecords[pluginId], {
      source: "npm",
      spec: priorSpec,
      installPath: targetDir,
      version: "2026.5.12",
    });
    expect(result).toEqual({
      changes: [installedMessage(pluginId, priorSpec)],
      warnings: [],
      repairedPluginIds: [pluginId],
      pluginInventoryChanged: true,
      records: persistedRecords,
    });
  });

  it("does not delete an arbitrary recorded path when replacing a broken official plugin", async () => {
    const installDir = tempDirs.make("openclaw-plugin-stub-repair-");
    writeStub(installDir, "brave");
    mockBrokenBraveInstall(installDir, {
      source: "npm",
      spec: "@openclaw/brave-plugin@2026.5.1-beta.1",
      clawhubPackage: BRAVE,
      clawhubChannel: "official",
      clawhubUrl: "https://clawhub.ai",
    });
    installNpm.mockResolvedValueOnce(artifact("brave", BRAVE, "2026.5.12"));

    await repairConfiguredPlugins({ tools: { web: { search: { provider: "brave" } } } });

    expect(fs.existsSync(installDir)).toBe(true);
    expect(installNpm).toHaveBeenCalled();
  });

  it.each(["one-shot-callback", "one-shot-lease"] as const)(
    "rechecks live authority after async replacement planning (revoked: %s)",
    async (revoke) => {
      const { root, env, installDir, cfg, priorRecord } = brokenBrave();
      const replacementDir = path.join(root, "replacement");
      const payloadPath = path.join(installDir, "index.ts");
      writeStub(installDir, "brave", retainedPayload);
      stageBrave(replacementDir);
      mockBrokenBraveInstall(installDir, priorRecord);
      installNpm.mockResolvedValueOnce(artifact("brave", BRAVE, "2026.5.12", replacementDir));
      await useRealInstallIndexWrites();
      try {
        await seedInstalledPluginIndex(
          { brave: priorRecord },
          { env, config: cfg, candidates: [] },
        );
        const before = await readIndex({ env });
        const failure = new Error("update authority revoked after replacement planning");
        let current = true;
        let callbackChecks = 0;
        const beforePersistentEffect = vi.fn(async () => {
          if (revoke === "one-shot-callback" && callbackChecks++ === 0) {
            throw failure;
          }
          if (revoke === "one-shot-lease" && callbackChecks++ === 0) {
            queueMicrotask(() => {
              current = false;
            });
          }
        });
        const operation = withPluginLifecycleLease(
          {
            env,
            assertCurrent: () => {
              if (!current) {
                if (revoke === "one-shot-lease") {
                  current = true;
                }
                throw failure;
              }
            },
          },
          () => repairInstalls({ cfg, env, beforePersistentEffect }),
        );
        await expect(operation).rejects.toBe(failure);
        expect(readText(payloadPath)).toBe(retainedPayload);
        expect(await readIndex({ env })).toEqual(before);
        expect(beforePersistentEffect).toHaveBeenCalled();
        expect(fs.existsSync(path.join(replacementDir, "package.json"))).toBe(true);
      } finally {
        await closeDatabase(statePath(env));
      }
    },
  );

  it.each([
    "index-failure",
    "cleanup-failure",
    "cleanup-refusal",
    "path-replaced",
    "symlink-success",
    "symlink-replaced",
    "parent-symlink-replaced",
    "parent-target-replaced",
  ] as const)(
    "settles an alternate-path repair before retiring the old payload: %s",
    async (phase) => {
      const { root, env, extensionsDir, installDir, cfg, priorRecord } = brokenBrave();
      const sourceDir = path.join(root, "candidate");
      const replacementDir = path.join(root, "npm", "node_modules", "@openclaw", "brave-plugin");
      const replacedParent =
        phase === "parent-symlink-replaced" || phase === "parent-target-replaced";
      const realExtensionsDir = path.join(root, "real-extensions");
      const foreignExtensionsDir = path.join(root, "foreign-extensions");
      const retainedParent = path.join(root, "retained-extensions");
      if (replacedParent) {
        fs.mkdirSync(realExtensionsDir);
        fs.symlinkSync(realExtensionsDir, extensionsDir, "junction");
      }
      const linked = phase === "symlink-success" || phase === "symlink-replaced";
      const oldTarget = linked ? path.join(root, "old-link-target") : installDir;
      const foreignTarget = path.join(root, "foreign-link-target");
      fs.mkdirSync(oldTarget, { recursive: true });
      if (linked) {
        fs.mkdirSync(extensionsDir, { recursive: true });
        fs.symlinkSync(oldTarget, installDir, "junction");
      }
      const oldPayload = path.join(installDir, "index.ts");
      writeStub(installDir, "brave", retainedPayload);
      stageBrave(sourceDir);
      const newManifest = readText(sourceDir, "package.json");
      mockBrokenBraveInstall(installDir, priorRecord);
      await useRealInstallIndexWrites();
      await seedInstalledPluginIndex({ brave: priorRecord }, { env, config: cfg, candidates: [] });
      const before = await readIndex({ env });
      const failure = Object.assign(new Error(`fixture ${phase} failed`), { code: "EIO" });
      const retainedPath = path.join(root, "retained-old-payload");
      const effects: string[] = [];
      let indexCommitted = false;
      let oldPresentAtWrite = false;
      const writeIndex = expectDefined(
        persistRecords.getMockImplementation(),
        "real install-index writer",
      );
      persistRecords.mockImplementationOnce(async (records, options) => {
        effects.push("index");
        oldPresentAtWrite = fs.existsSync(oldPayload);
        expect(readText(replacementDir, "package.json")).toBe(newManifest);
        if (phase === "index-failure") {
          throw failure;
        }
        const receipt = await writeIndex(records, options);
        indexCommitted = true;
        if (replacedParent) {
          fs.renameSync(
            phase === "parent-symlink-replaced" ? extensionsDir : realExtensionsDir,
            retainedParent,
          );
          if (phase === "parent-symlink-replaced") {
            fs.mkdirSync(foreignExtensionsDir);
            fs.symlinkSync(foreignExtensionsDir, extensionsDir, "junction");
          } else {
            fs.mkdirSync(realExtensionsDir);
          }
          fs.mkdirSync(installDir, { recursive: true });
          fs.writeFileSync(oldPayload, "foreign payload");
        }
        if (phase === "path-replaced" || phase === "symlink-replaced") {
          fs.renameSync(installDir, retainedPath);
          if (linked) {
            fs.mkdirSync(foreignTarget);
            fs.symlinkSync(foreignTarget, installDir, "junction");
          } else {
            fs.mkdirSync(installDir);
          }
          fs.writeFileSync(oldPayload, "foreign payload");
        }
        return receipt;
      });
      installNpm.mockImplementationOnce(
        async (
          params: Parameters<
            typeof import("../../../plugins/install.js").installPluginFromNpmSpec
          >[0],
        ) => {
          const request = expectDefined(
            resolvePluginInstallTransactionRequest(params),
            "repair-owned deferred install request",
          );
          const assertOwned = expectDefined(request.assertOwned, "initiating repair authority");
          // Keep discovery controlled, but publish and roll back real package directories.
          const installed = await installPackageDir(
            requestDeferredPackageDirInstall(
              {
                sourceDir,
                targetDir: replacementDir,
                mode: "update",
                timeoutMs: 1_000,
                copyErrorPrefix: "fixture publication failed",
                hasDeps: false,
                depsLogMessage: "",
                beforePersistentApply: assertOwned,
              },
              assertOwned,
            ),
          );
          expect(installed).toMatchObject({ ok: true });
          const transaction = expectDefined(
            resolvePackageDirInstallTransaction(installed),
            "real directory install transaction",
          );
          return attachPluginInstallTransaction(
            artifact("brave", BRAVE, "2026.5.12", replacementDir),
            {
              commit: async () => {
                await transaction.commit();
                effects.push("package-commit");
              },
              rollback: async () => {
                await transaction.rollback();
                effects.push("package-rollback");
              },
            },
          );
        },
      );
      const prototype = Object.getPrototypeOf(await fsSafeRoot(extensionsDir)) as Root;
      // oxlint-disable-next-line typescript/unbound-method -- Retain the intercepted Root receiver below.
      const remove = prototype.remove;
      const removeSpy = vi.spyOn(prototype, "remove").mockImplementation(async function (
        this: Root,
        target,
        options,
      ) {
        if (
          normalizeComparablePath(path.join(this.rootReal, target)) ===
          normalizeComparablePath(linked ? installDir : oldPayload)
        ) {
          effects.push("retire");
          if (phase === "cleanup-failure") {
            throw failure;
          }
        }
        await remove.call(this, target, options);
      });
      const onWarning = vi.fn();
      try {
        const operation = repairInstalls({
          cfg,
          env,
          onWarning,
          beforePersistentEffect: () => {
            if (indexCommitted && phase === "cleanup-refusal") {
              throw failure;
            }
          },
        });
        if (phase === "path-replaced" || phase === "symlink-replaced" || replacedParent) {
          await expect(operation).rejects.toBeInstanceOf(AggregateError);
        } else if (phase === "index-failure" || phase === "cleanup-refusal") {
          await expect(operation).rejects.toBe(failure);
        } else {
          const result = await operation;
          expectRecordFields(result, {
            repairedPluginIds: ["brave"],
            warnings:
              phase === "cleanup-failure"
                ? [
                    `Failed to remove broken installed plugin "brave" at ${installDir}: ${String(failure)}`,
                  ]
                : [],
          });
        }
        if (phase === "index-failure") {
          expect(await readIndex({ env })).toEqual(before);
          const observed = {
            oldPresentAtWrite,
            oldPayloadRetained: fs.existsSync(oldPayload),
            replacementPresent: fs.existsSync(replacementDir),
          };
          expect(observed, `retirement state: ${JSON.stringify(observed)}`).toEqual({
            oldPresentAtWrite: true,
            oldPayloadRetained: true,
            replacementPresent: false,
          });
          expect(effects).toEqual(["index", "package-rollback"]);
        } else {
          expect(oldPresentAtWrite).toBe(true);
          expect((await readIndex({ env }))?.installRecords.brave?.installPath).toBe(
            replacementDir,
          );
          expect(readText(replacementDir, "package.json")).toBe(newManifest);
          expect(effects).toEqual(
            phase === "cleanup-refusal" ||
              phase === "path-replaced" ||
              phase === "symlink-replaced" ||
              replacedParent
              ? ["index", "package-commit"]
              : ["index", "package-commit", "retire"],
          );
        }
        if (phase === "symlink-success") {
          expect(fs.lstatSync(installDir, { throwIfNoEntry: false })).toBeUndefined();
        } else if (replacedParent) {
          expect(readText(oldPayload)).toBe("foreign payload");
          expect(readText(retainedParent, "brave", "index.ts")).toBe(retainedPayload);
        } else if (phase === "path-replaced" || phase === "symlink-replaced") {
          expect(readText(oldPayload)).toBe("foreign payload");
          expect(readText(retainedPath, "index.ts")).toBe(retainedPayload);
        } else {
          expect(readText(oldPayload)).toBe(retainedPayload);
        }
        if (linked) {
          expect(readText(oldTarget, "index.ts")).toBe(retainedPayload);
          if (phase === "symlink-replaced") {
            expectLink(installDir, foreignTarget);
            expect(readText(foreignTarget, "index.ts")).toBe("foreign payload");
          }
        }
        if (replacedParent) {
          expectLink(
            extensionsDir,
            phase === "parent-symlink-replaced" ? foreignExtensionsDir : realExtensionsDir,
          );
        }
        expect(onWarning).toHaveBeenCalledTimes(phase === "cleanup-failure" ? 1 : 0);
      } finally {
        removeSpy.mockRestore();
        await closeDatabase(statePath(env));
      }
    },
  );

  it("does not replace a non-official install that collides with an official plugin id", async () => {
    const extensionsDir = path.join(tempDirs.make("openclaw-plugin-stub-repair-"), "extensions");
    const installDir = path.join(extensionsDir, "brave");
    mocks.resolveDefaultPluginExtensionsDir.mockReturnValue(extensionsDir);
    writeStub(installDir, "brave");
    const records = mockBrokenBraveInstall(installDir, { source: "path", sourcePath: installDir });

    const result = await repairConfiguredPlugins({
      tools: { web: { search: { provider: "brave" } } },
    });

    expect(fs.existsSync(installDir)).toBe(true);
    notCalled(installNpm, mocks.updateNpmInstalledPlugins);
    expect(result).toEqual({ changes: [], warnings: [], records });
  });

  it("installs configured external speech and web-fetch plugins from selected providers", async () => {
    const packages = [
      ["firecrawl", FIRECRAWL],
      ["gradium", "@openclaw/gradium-speech"],
      ["inworld", "@openclaw/inworld-speech"],
    ] as const;
    setOfficial(...packages.map(([id, npmSpec]) => officialPluginEntry({ id, npmSpec })));
    mocks.resolveOfficialExternalProviderContractPluginIds.mockImplementation(
      ({ contract }: { contract: string }) => {
        if (contract === "webFetchProviders") {
          return ["firecrawl"];
        }
        if (contract === "speechProviders") {
          return ["gradium", "inworld"];
        }
        return [];
      },
    );
    for (const [pluginId, npmSpec] of packages) {
      installNpm.mockResolvedValueOnce(artifact(pluginId, npmSpec));
    }

    const result = await repairConfiguredPlugins({
      tts: { provider: "gradium", providers: { inworld: {} } },
      tools: { web: { fetch: { provider: "firecrawl" } } },
    });

    expect(
      installNpm.mock.calls.map(
        ([params]) => (params as { expectedPluginId?: string }).expectedPluginId,
      ),
    ).toEqual(["firecrawl", "gradium", "inworld"]);
    expect(result.changes).toEqual(
      packages.map(([pluginId, npmSpec]) =>
        installedMessage(pluginId, expectedNpmInstallSpec(npmSpec)),
      ),
    );
  });

  it.each(
    // prettier-ignore
    [
    ["installs the official llama.cpp plugin for configured local memory embeddings", "llama-cpp", "@openclaw/llama-cpp-provider", "2026.6.2", {
        id: "llama-cpp",
        label: "llama.cpp Provider",
        openclaw: {
          plugin: { id: "llama-cpp", label: "llama.cpp Provider" },
          contracts: { embeddingProviders: ["local"] },
          install: { npmSpec: "@openclaw/llama-cpp-provider", defaultChoice: "npm" as const, },
        },
        install: { npmSpec: "@openclaw/llama-cpp-provider", defaultChoice: "npm" as const, },
      }, { memory: { search: { provider: "local" } }, agents: { defaults: {} } }],
    ["does not let runtime fallback metadata override official catalog install specs", "acpx", "@openclaw/acpx", "2026.5.2-beta.2", {
        id: "acpx",
        label: "ACPX Runtime",
        install: { npmSpec: "@openclaw/acpx", defaultChoice: "npm" as const },
      }, { acp: { backend: "acpx" } }],
    ["installs an external media-understanding provider selected only by media config", "groq", "@openclaw/groq-provider", undefined, officialPluginEntry({
        id: "groq",
        npmSpec: "@openclaw/groq-provider",
        label: "Groq",
        manifest: { contracts: { mediaUnderstandingProviders: ["groq"] } },
      }), {
        tools: {
          media: { models: [ { provider: "groq", model: "whisper-large-v3-turbo", capabilities: ["audio"], }, ], },
        },
      } satisfies OpenClawConfig],
  ] as const,
  )("%s", async (_name, pluginId, npmSpec, version, entry, cfg) => {
    setOfficial(entry);
    installNpm.mockResolvedValueOnce(artifact(pluginId, npmSpec, version));

    const result = await repairConfiguredPlugins(cfg);

    expectRecordFields(mockCallArg(installNpm), {
      spec: expectedNpmInstallSpec(npmSpec),
      expectedPluginId: pluginId,
      trustedSourceLinkedOfficialInstall: true,
    });
    expect(installClawHub).not.toHaveBeenCalled();
    expect(result.changes).toEqual([installedMessage(pluginId, expectedNpmInstallSpec(npmSpec))]);
  });

  it("does not install an env-selected denied search plugin", async () => {
    const cfg: OpenClawConfig = { plugins: { deny: ["brave"] } };
    const env = { BRAVE_API_KEY: "brave-key" };
    const packages = [
      ["brave", BRAVE, "BRAVE_API_KEY"],
      ["perplexity", "@openclaw/perplexity-plugin", "PERPLEXITY_API_KEY"],
    ] as const;
    setOfficial(
      ...packages.map(([id, npmSpec, envVar]) =>
        officialWebSearchPluginEntry({
          id,
          npmSpec,
          envVar,
          providerLabel: `${id} search`,
          credentialPath: `plugins.entries.${id}.config.webSearch.apiKey`,
          includeManifestInstall: true,
        }),
      ),
    );
    useManifestCatalogResolvers();
    installNpm.mockImplementation(async ({ expectedPluginId }: { expectedPluginId: string }) =>
      successfulInstall({
        pluginId: expectedPluginId,
        npmSpec: expectDefined(
          packages.find(([id]) => id === expectedPluginId),
          "expected search plugin package",
        )[1],
      }),
    );

    const result = await repairConfiguredPlugins(cfg, env);

    notCalled(installNpm, installClawHub);
    expect(Object.keys(result.records)).toEqual([]);
    expectRecordFields(result, { changes: [], warnings: [] });
    expect(persistRecords).not.toHaveBeenCalled();
  });

  it("leaves retired npm declaration stubs untouched without using their install spec", async () => {
    const root = tempDirs.make("openclaw-plugin-stub-retired-");
    const pluginDir = path.join(root, "extensions", "guardrail-bridge");
    const sourcePath = path.join(pluginDir, "openclaw.extension.json");
    const source = JSON.stringify({
      name: "guardrail-bridge",
      type: "npm",
      npmSpec: "@guardrail-bridge/guardrail-bridge@1.0.0",
    });
    fs.mkdirSync(pluginDir, { recursive: true });
    fs.writeFileSync(sourcePath, source);

    const result = await repairConfiguredPlugins({
      plugins: { load: { paths: [pluginDir] }, entries: { "guardrail-bridge": { enabled: true } } },
    });

    notCalled(installNpm, installClawHub, persistRecords);
    expect(result.changes).toEqual([]);
    expect(readText(sourcePath)).toBe(source);
  });

  it("installs Firecrawl for env-only web fetch when search is disabled", async () => {
    mocks.resolveOfficialExternalWebProviderContractPluginIdsForEnv.mockReturnValue(["firecrawl"]);
    setOfficial(
      officialPluginEntry({
        id: "firecrawl",
        npmSpec: FIRECRAWL,
        label: "Firecrawl",
        manifest: {},
      }),
    );
    installNpm.mockResolvedValueOnce(
      successfulInstall({ pluginId: "firecrawl", npmSpec: FIRECRAWL }),
    );

    const env = { FIRECRAWL_API_KEY: "firecrawl-key" };
    const result = await repairConfiguredPlugins(
      { tools: { web: { search: { enabled: false } } } },
      env,
    );

    expect(mocks.resolveOfficialExternalWebProviderContractPluginIdsForEnv).toHaveBeenCalledWith({
      contract: "webFetchProviders",
      env: { ...testEnv, ...env },
    });
    expectRecordFields(mockCallArg(installNpm), {
      spec: expectedNpmInstallSpec(FIRECRAWL),
      expectedPluginId: "firecrawl",
      trustedSourceLinkedOfficialInstall: true,
    });
    expect(result.changes).toEqual([
      installedMessage("firecrawl", expectedNpmInstallSpec(FIRECRAWL)),
    ]);
  });
});
/* oxlint-disable max-lines -- TODO: split this grandfathered oversized file. */
