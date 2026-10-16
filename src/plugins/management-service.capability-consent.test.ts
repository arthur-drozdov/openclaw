import fs from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { ConfigReplaceInput } from "../config/mutate.js";
import type { PluginInstallRecord } from "../config/types.plugins.js";
import { resolvePluginArtifactDeclaredSurface } from "./capability-artifact.js";
import {
  createManagedPluginArtifactConsentHandler,
  resolvePluginCapabilityConsent,
  type PluginCapabilityConsentHandler,
} from "./capability-consent.js";
import { buildPluginCapabilitySummary, computeDeclaredSurfaceHash } from "./capability-summary.js";
import { recordInstalledPluginIndexInstallOwner } from "./installed-plugin-index-install-owner.js";
import { loadInstalledPluginIndexWithDiscovery } from "./installed-plugin-index.js";
import {
  configSnapshot,
  emptyMetadataSnapshot,
  metadataSnapshot,
} from "./management-service.test-helpers.js";
import { clearPluginMetadataLifecycleCaches } from "./plugin-metadata-lifecycle.js";
import { createColdPluginFixture } from "./test-helpers/cold-plugin-fixtures.js";
import { cleanupTrackedTempDirs, makeTrackedTempDir } from "./test-helpers/fs-fixtures.js";

const mocks = vi.hoisted(() => ({
  metadata: vi.fn(),
  officialCatalog: vi.fn(),
  readConfig: vi.fn(),
  records: {} as Record<string, import("../config/types.plugins.js").PluginInstallRecord>,
  replaceConfig: vi.fn(),
  writeRecords: vi.fn(),
  slotSelection: vi.fn((config) => config),
}));

vi.mock("../config/config.js", () => ({
  assertConfigWriteAllowedInCurrentMode: () => undefined,
  readConfigFileSnapshotForWrite: () => mocks.readConfig(),
  replaceConfigFile: mocks.replaceConfig,
}));

vi.mock("./install-config-mutation.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./install-config-mutation.js")>()),
  resolveInstallConfigMutationPreflights: () => ({
    hookMutation: { mode: "allowed" },
    pluginMutation: { mode: "allowed" },
  }),
  selectInstallMutationWriteOptions: (writeOptions: unknown) => writeOptions,
}));

vi.mock("./installed-plugin-index-records.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./installed-plugin-index-records.js")>()),
  loadInstalledPluginIndexInstallRecords: async () => ({ ...mocks.records }),
  writePersistedInstalledPluginIndexInstallRecordsWithLease: async (
    records: Record<string, PluginInstallRecord>,
    options: unknown,
  ) => {
    mocks.records = { ...records };
    mocks.writeRecords(records, options);
  },
}));

vi.mock("./plugin-lifecycle-lease.js", () => ({
  withPluginLifecycleLease: async (
    _options: unknown,
    run: (lease: { assertOwned: () => void }) => Promise<unknown>,
  ) => run({ assertOwned: () => undefined }),
}));

vi.mock("./slot-selection.js", () => ({ applySlotSelectionForPlugin: mocks.slotSelection }));
vi.mock("./registry-refresh.js", () => ({ refreshPluginRegistryAfterConfigMutation: vi.fn() }));

vi.mock("./plugin-metadata-snapshot.js", () => ({
  loadPluginMetadataSnapshot: mocks.metadata,
  resolvePluginMetadataSnapshot: mocks.metadata,
}));

vi.mock("./official-external-plugin-catalog.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./official-external-plugin-catalog.js")>()),
  loadConfiguredHostedOfficialExternalPluginCatalogEntries: mocks.officialCatalog,
}));

const { clearManagedPluginCatalogCache } = await import("./management-catalog.js");
const { inspectManagedPlugin, listManagedPlugins } = await import("./management-service.js");
const { setManagedPluginEnabled } = await import("./management-mutations.js");

const trackedArtifactDirs: string[] = [];
const communityId = "community-plugin";
const communityName = "Community Plugin";

type ConsentOptions = Parameters<typeof resolvePluginCapabilityConsent>[0];
const consent = (options: Partial<ConsentOptions> = {}) =>
  resolvePluginCapabilityConsent({ config: {}, env: {}, pluginId: communityId, ...options });
const inspectCommunity = () => inspectManagedPlugin({ config: {}, env: {}, pluginId: communityId });
const enable = (options: Partial<Parameters<typeof setManagedPluginEnabled>[0]> = {}) =>
  setManagedPluginEnabled({ pluginId: communityId, enabled: true, env: {}, ...options });
function artifactHandler(
  options: Partial<Parameters<typeof createManagedPluginArtifactConsentHandler>[0]> = {},
) {
  return createManagedPluginArtifactConsentHandler({ config: {}, source: "npm", ...options });
}
function commitArtifact(
  handler: ReturnType<typeof artifactHandler>,
  stagedArtifactDir: string,
  sourceRecord?: PluginInstallRecord,
  pluginId = "diffs",
) {
  return handler.onBeforePluginArtifactCommit({
    pluginId,
    stagedArtifactDir,
    mode: "install",
    ...(sourceRecord ? { sourceRecord } : {}),
  });
}
const emptySurface = { providers: [], channels: [], channelConfigs: {}, providerAuthChoices: [] };
function isolatedEnv(rootDir: string) {
  return {
    HOME: rootDir,
    OPENCLAW_STATE_DIR: path.join(rootDir, "state"),
    OPENCLAW_DISABLE_BUNDLED_PLUGINS: "1",
    OPENCLAW_DISABLE_BUNDLED_SOURCE_OVERLAYS: "1",
  };
}
function discoveredMetadata(
  config: ConsentOptions["config"],
  env: NodeJS.ProcessEnv,
  installRecords = mocks.records,
) {
  const { index, manifestRegistry } = loadInstalledPluginIndexWithDiscovery({
    config,
    env,
    installRecords,
  });
  return {
    index,
    byPluginId: new Map(manifestRegistry.plugins.map((manifest) => [manifest.id, manifest])),
    plugins: manifestRegistry.plugins,
    diagnostics: manifestRegistry.diagnostics,
    normalizePluginId: (pluginId: string) => pluginId,
  };
}

function createConsentArtifact(pluginId = communityId, providers: string[] = []): string {
  const rootDir = makeTrackedTempDir("managed-capability-consent", trackedArtifactDirs);
  writeConsentArtifact(rootDir, pluginId, providers);
  return rootDir;
}

function writeConsentArtifact(rootDir: string, pluginId: string, providers: string[] = []): void {
  createColdPluginFixture({
    rootDir,
    pluginId,
    manifest: { ...emptySurface, name: communityName, providers },
  });
}

function installRecord(
  overrides: Partial<PluginInstallRecord> = {},
): PluginInstallRecord & { installPath: string } {
  return {
    source: "npm",
    integrity: "sha512-verified-artifact",
    ...overrides,
    installPath: overrides.installPath ?? createConsentArtifact(),
  };
}

function artifactReviewToken(record: PluginInstallRecord & { installPath: string }): string {
  return computeDeclaredSurfaceHash(resolvePluginArtifactDeclaredSurface(record.installPath));
}

function configureExternalPlugin(record: PluginInstallRecord) {
  mocks.records = { [communityId]: record };
  const snapshot = metadataSnapshot({
    id: communityId,
    name: communityName,
    enabled: false,
    origin: "global",
    installRecord: record,
  });
  if (record.installPath) {
    snapshot.index.plugins[0]!.rootDir = record.installPath;
    snapshot.byPluginId.get(communityId)!.rootDir = record.installPath;
  }
  mocks.metadata.mockImplementation(() => ({
    ...snapshot,
    index: { ...snapshot.index, installRecords: { ...mocks.records } },
  }));
  return snapshot;
}

afterEach(() => cleanupTrackedTempDirs(trackedArtifactDirs));

beforeEach(() => {
  vi.clearAllMocks();
  clearManagedPluginCatalogCache();
  clearPluginMetadataLifecycleCaches();
  mocks.records = {};
  mocks.officialCatalog.mockResolvedValue({ source: "hosted", entries: [] });
  mocks.readConfig.mockResolvedValue(configSnapshot());
  mocks.replaceConfig.mockImplementation(async (params: ConfigReplaceInput) => {
    const config = params.sourceConfig ?? params.nextConfig;
    return {
      path: "/tmp/openclaw.json",
      nextConfig: config,
      persistedHash: "committed",
      persistedSourceConfig: config,
    };
  });
});

it.each([
  { name: "global disable", plugins: { enabled: false }, reason: "plugins disabled" },
  { name: "denylist", plugins: { deny: [communityId] }, reason: "blocked by denylist" },
  {
    name: "restrictive allowlist",
    plugins: { allow: ["other-plugin"] },
    reason: "blocked by allowlist",
  },
])(
  "preserves CLI $name before consent, persistence, or slot selection",
  async ({ plugins, reason }) => {
    const record = installRecord();
    configureExternalPlugin(record);
    mocks.readConfig.mockResolvedValue(configSnapshot({ plugins }));
    const applyRuntime = vi.fn();
    await expect(
      enable({
        allowlistPolicy: "preserve" as const,
        acknowledgeCapabilities: { reviewToken: artifactReviewToken(record) },
        applyRuntime,
      }),
    ).rejects.toThrow(reason);
    expect(mocks.writeRecords).not.toHaveBeenCalled();
    expect(mocks.replaceConfig).not.toHaveBeenCalled();
    expect(mocks.slotSelection).not.toHaveBeenCalled();
    expect(applyRuntime).not.toHaveBeenCalled();
  },
);

it.each([
  { name: "admin omission", pluginId: communityId, allowlistPolicy: undefined },
  {
    name: "explicit-selection exception",
    pluginId: "clickclack",
    allowlistPolicy: "preserve" as const,
  },
])("retains $name enablement", async ({ pluginId, allowlistPolicy }) => {
  mocks.metadata.mockReturnValue(metadataSnapshot({ enabled: false, id: pluginId }));
  mocks.readConfig.mockResolvedValue(configSnapshot({ plugins: { allow: ["other-plugin"] } }));
  const applyRuntime = vi.fn(async () => ({
    operationId: "enable",
    generation: 2,
    pluginIds: [pluginId],
  }));
  await enable({ pluginId, ...(allowlistPolicy ? { allowlistPolicy } : {}), applyRuntime });
  expect(mocks.replaceConfig).toHaveBeenCalledWith(
    expect.objectContaining({
      sourceConfig: expect.objectContaining({
        plugins: expect.objectContaining({ allow: ["other-plugin", pluginId] }),
      }),
    }),
  );
  expect(mocks.slotSelection).toHaveBeenCalledOnce();
  expect(applyRuntime).toHaveBeenCalledOnce();
});

function officialArtifact() {
  const rootDir = makeTrackedTempDir("official-capability-consent", trackedArtifactDirs);
  createColdPluginFixture({
    rootDir,
    pluginId: "diffs",
    packageName: "@openclaw/diffs",
    manifest: emptySurface,
  });
  return rootDir;
}

const officialSources: PluginInstallRecord[] = [
  {
    source: "npm",
    spec: "@openclaw/diffs@1.0.0",
    resolvedName: "@openclaw/diffs",
    resolvedSpec: "@openclaw/diffs@1.0.0",
    integrity: "sha512-official-artifact",
  },
  {
    source: "clawhub",
    spec: "clawhub:@openclaw/diffs@1.0.0",
    clawhubPackage: "@openclaw/diffs",
    clawhubUrl: "https://clawhub.ai",
    clawhubChannel: "official",
    integrity: "sha256-official-artifact",
  },
];

it.each(officialSources)(
  "installs verified official $source artifacts without recording operator acceptance",
  async (sourceRecord) => {
    const rootDir = officialArtifact();
    const onCapabilityConsent = vi.fn<PluginCapabilityConsentHandler>();
    const handler = artifactHandler({
      source: sourceRecord.source,
      spec: sourceRecord.spec,
      onCapabilityConsent,
    });
    await expect(commitArtifact(handler, rootDir, sourceRecord)).resolves.toBeUndefined();
    expect(onCapabilityConsent).not.toHaveBeenCalled();
    expect(handler.applyAcceptedSurface("diffs", sourceRecord)).toEqual(sourceRecord);
  },
);

it("requires review for a custom ClawHub server", async () => {
  const sourceRecord = { ...officialSources[1]!, clawhubUrl: "https://plugins.example" };
  const handler = artifactHandler({ source: sourceRecord.source, spec: sourceRecord.spec });
  await expect(commitArtifact(handler, officialArtifact(), sourceRecord)).rejects.toMatchObject({
    capabilityConsent: { pluginId: "diffs" },
  });
});

it("rechecks first-party package identity after the commit guard yields", async () => {
  const rootDir = officialArtifact();
  const handler = artifactHandler({
    beforePersistentEffect: async () => {
      const packagePath = path.join(rootDir, "package.json");
      const manifest = JSON.parse(fs.readFileSync(packagePath, "utf8"));
      fs.writeFileSync(packagePath, JSON.stringify({ ...manifest, name: "@vendor/diffs" }));
    },
  });
  await expect(commitArtifact(handler, rootDir, officialSources[0])).rejects.toMatchObject({
    capabilityConsent: { pluginId: "diffs" },
  });
});

it("does not carry a first-party exemption into an unverified fallback stage", async () => {
  const rootDir = officialArtifact();
  const handler = artifactHandler();
  await commitArtifact(handler, rootDir, officialSources[0]);
  await expect(commitArtifact(handler, rootDir)).rejects.toMatchObject({
    capabilityConsent: { pluginId: "diffs" },
  });
  expect(() => handler.applyAcceptedSurface("diffs", officialSources[0]!)).toThrow(
    "did not expose its verified artifact",
  );
});

it("enables and reports a verified official install without legacy acceptance", async () => {
  const rootDir = officialArtifact();
  const record = { ...officialSources[0]!, installPath: rootDir };
  const config = { plugins: { load: { paths: [rootDir] }, entries: { diffs: { enabled: true } } } };
  const env = isolatedEnv(rootDir);
  const metadata = discoveredMetadata(config, env, { diffs: record });
  mocks.records = { diffs: record };
  mocks.metadata.mockReturnValue(metadata);
  await expect(
    resolvePluginCapabilityConsent({ config, env, pluginId: "diffs" }),
  ).resolves.toBeUndefined();
  expect(mocks.writeRecords).not.toHaveBeenCalled();
  const catalog = await listManagedPlugins({ config, env });
  expect(catalog.diagnostics).not.toContainEqual(
    expect.objectContaining({ message: expect.stringContaining("requires capability consent") }),
  );
});

it("rejects enabling an unaccepted plugin with only its reviewed-surface challenge", async () => {
  const record = installRecord();
  const snapshot = configureExternalPlugin(record);
  const manifest = snapshot.byPluginId.get(communityId)!;
  manifest.providers.push("community-provider");
  writeConsentArtifact(record.installPath!, communityId, ["community-provider"]);

  await expect(enable()).rejects.toMatchObject({
    capabilityConsent: { pluginId: communityId, reviewToken: artifactReviewToken(record) },
    message: expect.stringContaining(
      "Rerun the openclaw plugins install, enable, update, or reload command with --accept-capabilities after reviewing the plugin.",
    ),
  });
  expect(mocks.replaceConfig).not.toHaveBeenCalled();
});

it("persists an interactive acknowledgment for a home-relative path and reuses it", async () => {
  const artifactDir = createConsentArtifact();
  const env = { HOME: path.dirname(artifactDir) };
  const installPath = `~/${path.basename(artifactDir)}`;
  const record = installRecord({ installPath });
  const snapshot = configureExternalPlugin(record);
  snapshot.index.plugins[0]!.rootDir = artifactDir;
  snapshot.byPluginId.get(communityId)!.rootDir = artifactDir;
  const reviewToken = computeDeclaredSurfaceHash(resolvePluginArtifactDeclaredSurface(artifactDir));
  const onCapabilityConsent = vi.fn<PluginCapabilityConsentHandler>(async (review) => ({
    reviewToken: review.reviewToken,
  }));
  await consent({ env, onCapabilityConsent });

  const persisted = mocks.records[communityId]!;
  expect(persisted).toMatchObject({
    installPath,
    acceptedSurfaceHash: reviewToken,
    acceptedSurfaceIntegrity: "sha512-verified-artifact",
    acceptedSurfaceAt: expect.any(String),
  });
  expect(mocks.writeRecords).toHaveBeenCalledWith(
    expect.objectContaining({ [communityId]: persisted }),
    expect.objectContaining({ config: {}, env, lease: expect.any(Object) }),
  );

  await expect(consent({ env, onCapabilityConsent })).resolves.toBeUndefined();
  expect(mocks.writeRecords).toHaveBeenCalledTimes(1);
  expect(onCapabilityConsent).toHaveBeenCalledTimes(1);
});

it("inspects the actual configured override and its package siblings before accepting either", async () => {
  const record = installRecord();
  const rootDir = record.installPath!;
  writeConsentArtifact(rootDir, communityId, ["package-provider"]);
  for (const [directory, entry, provider] of [
    ["a", "first", "configured-provider"],
    ["b", "second", "ignored-provider"],
  ] as const) {
    const childDir = path.join(rootDir, directory);
    fs.mkdirSync(childDir);
    writeConsentArtifact(childDir, `${entry}-plugin`, [provider]);
    fs.writeFileSync(path.join(childDir, `${entry}.cjs`), "module.exports = {};");
  }
  fs.writeFileSync(
    path.join(rootDir, "package.json"),
    JSON.stringify({
      name: communityId,
      openclaw: { extensions: ["./a/first.cjs", "./b/second.cjs"] },
    }),
  );
  const config = {
    plugins: {
      load: { paths: [path.join(rootDir, "a/first.cjs")] },
      entries: {
        "first-plugin": { enabled: false },
        "community-plugin/second": { enabled: false },
      },
    },
  };
  const env = isolatedEnv(rootDir);
  mocks.records = { [communityId]: record };
  const metadata = discoveredMetadata(config, env);
  const manifests = metadata.byPluginId;
  mocks.metadata.mockImplementation(() => ({
    ...metadata,
    index: { ...metadata.index, installRecords: { ...mocks.records } },
  }));

  const inspections = await Promise.all(
    ["first-plugin", "community-plugin/second"].map((pluginId) =>
      inspectManagedPlugin({ config, env, pluginId }),
    ),
  );
  const declared = resolvePluginArtifactDeclaredSurface(rootDir, env, { config });
  expect(declared.providers).toEqual(["configured-provider", "package-provider"]);
  const reviewToken = computeDeclaredSurfaceHash(declared);

  expect(inspections.map((inspection) => inspection.overview?.capabilities?.providers)).toEqual([
    ["configured-provider"],
    ["package-provider"],
  ]);
  for (const inspection of inspections) {
    expect({ declared: inspection.declared, reviewToken: inspection.reviewToken }).toEqual({
      declared,
      reviewToken,
    });
    await expect(
      consent({ config, env, pluginId: inspection.plugin.id, acknowledge: { reviewToken } }),
    ).resolves.toBeUndefined();
  }
  expect(mocks.records[communityId]).toMatchObject({
    acceptedSurface: { providers: ["configured-provider", "package-provider"] },
    acceptedSurfaceHash: reviewToken,
  });
  expect(mocks.writeRecords).toHaveBeenCalledTimes(1);

  manifests.delete("community-plugin/second");
  await expect(inspectManagedPlugin({ config, env, pluginId: "first-plugin" })).rejects.toThrow(
    "incomplete manifest metadata",
  );
});

it("rechecks the installed artifact after interactive consent yields", async () => {
  const record = installRecord();
  configureExternalPlugin(record);
  const reviewedToken = artifactReviewToken(record);
  const onCapabilityConsent = vi.fn<PluginCapabilityConsentHandler>(async (review) => {
    await Promise.resolve();
    writeConsentArtifact(record.installPath!, communityId, ["unreviewed-provider"]);
    return { reviewToken: review.reviewToken };
  });

  await expect(consent({ onCapabilityConsent })).rejects.toMatchObject({
    capabilityConsent: { pluginId: communityId },
  });
  expect(onCapabilityConsent).toHaveBeenCalledWith(
    expect.objectContaining({ reviewToken: reviewedToken }),
  );
  expect(mocks.writeRecords).not.toHaveBeenCalled();
  const inspection = await inspectCommunity();
  expect(inspection.declared.providers).toEqual(["unreviewed-provider"]);
  expect(inspection.reviewToken).not.toBe(reviewedToken);
});

it("reports newly declared capabilities when the installed manifest outgrows acceptance", async () => {
  const previous = buildPluginCapabilitySummary({ manifest: {}, origin: "global" }).declared;
  const snapshot = configureExternalPlugin(
    installRecord({
      acceptedSurface: previous,
      acceptedSurfaceHash: computeDeclaredSurfaceHash(previous),
      acceptedSurfaceIntegrity: "sha512-verified-artifact",
      acceptedSurfaceAt: "2026-08-25T00:00:00.000Z",
    }),
  );
  snapshot.byPluginId.get(communityId)!.providers.push("new-provider");
  writeConsentArtifact(mocks.records[communityId]!.installPath!, communityId, ["new-provider"]);

  await expect(consent()).rejects.toMatchObject({
    capabilityConsent: {
      widened: { providers: ["new-provider"] },
      acceptedAt: "2026-08-25T00:00:00.000Z",
    },
  });
});

it("fails closed when an installed plugin has ambiguous package ownership", async () => {
  const snapshot = configureExternalPlugin(installRecord());
  recordInstalledPluginIndexInstallOwner(snapshot.index.plugins[0]!, undefined, true);

  await expect(consent()).rejects.toThrow("ambiguous package ownership");
  expect(mocks.writeRecords).not.toHaveBeenCalled();
});

it("retains a rejected community install for inspection and refreshes stale reviews", async () => {
  mocks.metadata.mockReturnValue(emptyMetadataSnapshot());
  const artifactDir = createConsentArtifact();
  const firstReviewToken = computeDeclaredSurfaceHash(
    resolvePluginArtifactDeclaredSurface(artifactDir),
  );
  const firstHandler = artifactHandler({ spec: communityId });

  await expect(
    commitArtifact(firstHandler, artifactDir, undefined, communityId),
  ).rejects.toMatchObject({
    capabilityConsent: { pluginId: communityId, reviewToken: firstReviewToken },
  });

  const firstInspection = await inspectCommunity();
  expect(firstInspection).toMatchObject({
    plugin: { id: communityId, name: communityName, installed: false },
    declared: { providers: [] },
    reviewToken: firstReviewToken,
  });

  writeConsentArtifact(artifactDir, communityId, ["unreviewed-provider"]);
  const refreshedToken = computeDeclaredSurfaceHash(
    resolvePluginArtifactDeclaredSurface(artifactDir),
  );
  const staleHandler = artifactHandler({
    spec: communityId,
    acknowledgeCapabilities: { reviewToken: firstReviewToken },
  });

  await expect(
    commitArtifact(staleHandler, artifactDir, undefined, communityId),
  ).rejects.toMatchObject({
    capabilityConsent: { pluginId: communityId, reviewToken: refreshedToken },
  });
  await expect(inspectCommunity()).resolves.toMatchObject({
    declared: { providers: ["unreviewed-provider"] },
    reviewToken: refreshedToken,
  });
});
