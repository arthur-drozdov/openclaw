import { afterEach, beforeEach, expect, it, vi } from "vitest";
import {
  createConfigResolutionFacts,
  setConfigResolutionFacts,
} from "../config/resolution-facts.js";
import { resetConfigRuntimeState, setRuntimeConfigSnapshot } from "../config/runtime-snapshot.js";
import type { McpServerConfig } from "../config/types.mcp.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import type { ClawHubPluginDetail } from "../infra/clawhub-plugin-catalog.js";
import * as bundleMcp from "./bundle-mcp.js";
import { computeDeclaredSurfaceHash } from "./capability-summary.js";
import {
  emptyMetadataSnapshot,
  hostedFeedDiffsEntry,
  metadataSnapshot as managementMetadataSnapshot,
} from "./management-service.test-helpers.js";
import { bindPluginMetadataSnapshotCache, createPluginCache } from "./plugin-cache.js";
import { clearPluginMetadataLifecycleCaches } from "./plugin-metadata-lifecycle.js";
import { createEmptyPluginRegistry } from "./registry-empty.js";
import { withPluginRuntimeRegistryScope } from "./runtime/gateway-request-scope.js";

const mocks = vi.hoisted(() => ({
  metadata: vi.fn(),
  officialCatalog: vi.fn(),
  mcpAuth: vi.fn(),
  remoteDetail: vi.fn(),
}));

vi.mock("../infra/clawhub-plugin-catalog.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../infra/clawhub-plugin-catalog.js")>()),
  fetchClawHubPluginDetail: mocks.remoteDetail,
}));

vi.mock("../agents/mcp-oauth.js", () => ({
  readMcpOAuthCredentialsStatuses: mocks.mcpAuth,
}));

vi.mock("./plugin-metadata-snapshot.js", () => ({
  loadPluginMetadataSnapshot: mocks.metadata,
  resolvePluginMetadataSnapshot: mocks.metadata,
}));

vi.mock("./official-external-plugin-catalog.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./official-external-plugin-catalog.js")>()),
  loadConfiguredHostedOfficialExternalPluginCatalogEntries: mocks.officialCatalog,
}));

const { clearManagedPluginCatalogCache } = await import("./management-catalog.js");
const { inspectManagedPlugin } = await import("./management-service.js");
type InspectOptions = Parameters<typeof inspectManagedPlugin>[0];
const inspect = (options: Partial<InspectOptions> = {}) =>
  inspectManagedPlugin({ config: {}, env: {}, pluginId: "workboard", ...options });
const oauthServer: McpServerConfig = {
  url: "https://example.test/mcp",
  auth: "oauth",
};
const enabledConfig = (servers?: Record<string, McpServerConfig>): OpenClawConfig => ({
  plugins: { entries: { workboard: { enabled: true } } },
  ...(servers ? { mcp: { servers } } : {}),
});
const authStatus = (state: string) => [{ serverName: "docs", state }];
const communityConfig: OpenClawConfig = {
  plugins: { entries: { "community-plugin": { hooks: { allowConversationAccess: true } } } },
};
function remoteDetail(overrides: Partial<ClawHubPluginDetail>) {
  mocks.remoteDetail.mockResolvedValue({
    packageName: "community/plugin",
    displayName: "Community Plugin",
    family: "code-plugin",
    isOfficial: false,
    categories: [],
    topics: [],
    configFields: [],
    mcpServers: [],
    skills: [],
    versions: [],
    tags: {},
    downloadability: { status: "downloadable" },
    metadata: { manifest: "available", readme: "missing", security: "missing" },
    ...overrides,
  });
}
function communityMetadata(installRecord: Record<string, unknown>) {
  const snapshot = metadataSnapshot({
    id: "community-plugin",
    name: "Community Plugin",
    enabled: false,
    origin: "global",
    installRecord: { installPath: "/tmp/community-plugin", ...installRecord },
  });
  mocks.metadata.mockReturnValue(snapshot);
  return snapshot;
}

function metadataSnapshot(
  params: Parameters<typeof managementMetadataSnapshot>[0] = { enabled: true },
  mcpServers?: Record<string, McpServerConfig>,
) {
  const snapshot = managementMetadataSnapshot(params);
  if (mcpServers) {
    snapshot.plugins[0]!.mcpServers = mcpServers;
  }
  return {
    ...snapshot,
    manifestRegistry: { plugins: snapshot.plugins, diagnostics: snapshot.diagnostics },
  };
}

afterEach(() => {
  vi.restoreAllMocks();
  resetConfigRuntimeState();
});

beforeEach(() => {
  clearPluginMetadataLifecycleCaches();
  clearManagedPluginCatalogCache();
  mocks.metadata.mockReset();
  mocks.officialCatalog.mockReset();
  mocks.officialCatalog.mockResolvedValue({ source: "hosted", entries: [] });
  mocks.mcpAuth.mockReset();
  mocks.remoteDetail.mockReset();
});

it.each([true, false])(
  "inspects an arbitrary selected ClawHub release with manifest available: %s",
  async (manifestAvailable) => {
    // A runtime ID collision is not a canonical ClawHub package match.
    mocks.metadata.mockReturnValue(metadataSnapshot({ enabled: true, id: "community-plugin" }));
    remoteDetail({
      runtimeId: "community-plugin",
      mcpServers: manifestAvailable ? ["docs"] : [],
      skills: manifestAvailable ? [{ name: "research" }] : [],
      ...(manifestAvailable
        ? { contracts: { tools: ["research_lookup"] }, providers: ["search"] }
        : {}),
      selectedRelease: { version: "1.2.3" },
      tags: { latest: "2.0.0" },
      metadata: {
        manifest: manifestAvailable ? "available" : "missing",
        readme: "available",
        security: "missing",
      },
      readme: "# Community Plugin",
      trust: { disposition: "review-required", reasons: ["Unverified publisher"] },
    });
    const inspection = await inspect({
      config: communityConfig,
      clawhub: { packageName: "community/plugin", version: "1.2.3" },
    });

    expect(inspection).toMatchObject({
      plugin: { name: "Community Plugin", version: "1.2.3", installed: false, enabled: false },
      source: { kind: "clawhub", packageName: "community/plugin" },
      declaredSurfaceStatus: manifestAvailable ? "partial" : "unavailable",
      declared: {
        tools: manifestAvailable ? ["research_lookup"] : [],
        mcpServers: manifestAvailable ? ["docs"] : [],
        skills: manifestAvailable ? ["research"] : [],
      },
      grants: { hooks: { allowConversationAccess: { effective: false } } },
      trust: { disposition: "review-required" },
      catalog: {
        detail: {
          packageName: "community/plugin",
          readme: "# Community Plugin",
          selectedRelease: { version: "1.2.3" },
        },
      },
    });
    expect(inspection.reviewToken).toBeUndefined();
    expect(inspection.overview?.capabilities === undefined).toBe(!manifestAvailable);
  },
);

it.each(["community-plugin", undefined, "another-plugin"])(
  "joins installed grants only for the selected runtime identity: %s",
  async (runtimeId) => {
    communityMetadata({
      source: "clawhub",
      clawhubPackage: "community/plugin",
      clawhubUrl: "https://clawhub.ai",
    });
    remoteDetail({
      runtimeId,
      selectedRelease: { version: "2.0.0" },
      contracts: { tools: ["new_tool"] },
    });
    const inspection = await inspect({
      config: communityConfig,
      clawhub: { packageName: "community/plugin", version: "2.0.0" },
    });

    expect(inspection).toMatchObject({
      plugin: { id: "community-plugin", installed: true, version: "2.0.0" },
      declared: { tools: ["new_tool"] },
      grants: {
        hooks: {
          allowConversationAccess:
            runtimeId === "community-plugin"
              ? { effective: true, configured: true }
              : { effective: false },
        },
      },
    });
    expect(inspection.reviewToken).toBeUndefined();
  },
);

it("offers installed account sign-in and follows operator configuration changes", async () => {
  mocks.metadata.mockReturnValue(
    metadataSnapshot(undefined, { docs: { ...oauthServer, transport: "streamable-http" } }),
  );
  mocks.mcpAuth.mockResolvedValue([{ state: "unauthenticated" }]);
  const config = enabledConfig();
  setRuntimeConfigSnapshot(config);
  const inspectCurrent = () => inspect({ config });
  const auth = authStatus("unauthenticated");
  expect((await inspectCurrent()).mcpAuth).toEqual(auth);
  expect(config.mcp).toBeUndefined();

  config.mcp = {
    servers: { docs: { url: "https://override.test/mcp", auth: "oauth" } },
  };
  expect((await inspectCurrent()).mcpAuth).toBeUndefined();
  config.mcp.servers!.docs!.url = "https://example.test/mcp";
  expect((await inspectCurrent()).mcpAuth).toEqual(auth);
  config.mcp.servers!.docs = { enabled: false };
  expect((await inspectCurrent()).mcpAuth).toBeUndefined();
  delete config.mcp.servers!.docs;
  expect((await inspectCurrent()).mcpAuth).toEqual(auth);
});

it("projects only eligible operator MCP connections without credential details", async () => {
  const states = [
    "unauthenticated",
    "pending-authorization",
    "requires-authorization",
    "authorized",
  ] as const;
  const servers = Object.fromEntries(
    states.map((state, i) => [
      `connection-${i}`,
      {
        transport: "streamable-http" as const,
        url: `https://example.test/${state}`,
        auth: "oauth" as const,
      },
    ]),
  );
  const base: McpServerConfig = { ...oauthServer, transport: "streamable-http" };
  const excluded: Record<string, McpServerConfig> = {
    disabled: { ...base, enabled: false },
    disabledOnly: { enabled: false },
    command: { ...base, command: "node" },
    unauthenticated: { ...base, auth: undefined },
    requester: { ...base, oauth: { identity: "per-requester" } },
    profile: { ...base, oauth: { authProfileId: "existing-account" } },
    unrelated: { ...base, url: "https://other.example.test/mcp" },
  };
  mocks.metadata.mockReturnValue(
    metadataSnapshot(undefined, {
      ...servers,
      ...Object.fromEntries(Object.keys(excluded).map((name) => [name, base])),
    }),
  );
  mocks.mcpAuth.mockResolvedValue(states.map((state) => ({ state, expiresAt: 100 })));

  const inspection = await inspect({ config: enabledConfig({ ...servers, ...excluded }) });

  expect(inspection.mcpAuth).toEqual(
    states.map((state, i) => ({ serverName: `connection-${i}`, state })),
  );
  expect(mocks.mcpAuth).toHaveBeenCalledWith(
    states.map((state, i) =>
      expect.objectContaining({
        serverName: `connection-${i}`,
        serverUrl: `https://example.test/${state}`,
        principal: "operator",
      }),
    ),
  );
});

it("reuses MCP ownership until config or metadata changes while reading OAuth state live", async () => {
  const snapshot = metadataSnapshot(undefined, { docs: oauthServer });
  const other = { ...snapshot.plugins[0]!, id: "other" };
  const metadata = {
    ...snapshot,
    manifestRegistry: { plugins: [...snapshot.plugins, other], diagnostics: [] },
  };
  bindPluginMetadataSnapshotCache(metadata, createPluginCache());
  mocks.metadata.mockReturnValue(metadata);
  const config = enabledConfig({ docs: oauthServer });
  config.plugins!.entries!.other = { enabled: false };
  setRuntimeConfigSnapshot(config);
  const load = vi.spyOn(bundleMcp, "loadEnabledBundleMcpConfig");
  async function expectAuth(state: string | undefined, loads: number, currentConfig = config) {
    expect((await inspect({ config: currentConfig })).mcpAuth).toEqual(
      state ? authStatus(state) : undefined,
    );
    expect(load).toHaveBeenCalledTimes(loads);
  }
  mocks.mcpAuth.mockResolvedValue([{ state: "unauthenticated" }]);
  await expectAuth("unauthenticated", 1);
  mocks.mcpAuth.mockResolvedValue([{ state: "authorized" }]);
  await expectAuth("authorized", 1);
  expect(mocks.mcpAuth).toHaveBeenCalledTimes(2);

  const shadowedConfig = {
    ...config,
    plugins: { entries: { workboard: { enabled: true }, other: { enabled: true } } },
  };
  await expectAuth(undefined, 2, shadowedConfig);
  await expectAuth("authorized", 2);

  const replacement = {
    ...metadata,
    manifestRegistry: { plugins: [other], diagnostics: [] },
  };
  bindPluginMetadataSnapshotCache(replacement, createPluginCache());
  mocks.metadata.mockReturnValue(replacement);
  await expectAuth(undefined, 3, shadowedConfig);
  mocks.metadata.mockReturnValue(metadata);
  await expectAuth("authorized", 3);

  config.plugins!.entries!.other!.enabled = true;
  setRuntimeConfigSnapshot(config);
  const shadowed = await inspect({ config });
  expect([shadowed.plugin.enabled, shadowed.mcpAuth]).toEqual([true, undefined]);
  config.plugins!.entries!.other!.enabled = false;
  setRuntimeConfigSnapshot(config);
  expect((await inspect({ config })).mcpAuth).toEqual(authStatus("authorized"));
});

it("omits resolver-owned requester credentials from operator plugin inspection", async () => {
  mocks.metadata.mockReturnValue(metadataSnapshot(undefined, { docs: oauthServer }));
  const registry = createEmptyPluginRegistry();
  registry.mcpServerConnectionResolvers.push({
    pluginId: "workboard",
    source: "/plugins/workboard/index.ts",
    resolver: { serverName: "docs", resolve: async () => null },
  });

  const inspection = await withPluginRuntimeRegistryScope(registry, () =>
    inspect({ config: enabledConfig({ docs: oauthServer }) }),
  );

  expect(inspection.mcpAuth).toBeUndefined();
  expect(mocks.mcpAuth).not.toHaveBeenCalled();
});

it.each([
  { value: undefined, env: {}, status: "missing" },
  { value: "private-literal", env: {}, status: "configured" },
  { value: undefined, env: { ALTERNATIVE_KEY: "private-env" }, status: "configured" },
  {
    value: { source: "file", provider: "vault", id: "/private/key" },
    env: {},
    status: "configured",
  },
  { value: { invalid: true }, env: {}, status: "invalid" },
  { value: "${WORKBOARD_KEY}", env: {}, status: "unresolved", unresolved: true },
])("projects only public credential status $status", async ({ value, env, status, unresolved }) => {
  mocks.metadata.mockReturnValue(metadataSnapshot({ enabled: true }));
  const registry = createEmptyPluginRegistry();
  registry.webSearchProviders.push({
    pluginId: "workboard",
    source: "/plugins/workboard/index.ts",
    provider: {
      id: "workboard",
      label: "Workboard",
      hint: "Search",
      placeholder: "",
      signupUrl: "",
      credentialPath: "plugins.entries.workboard.config.apiKey",
      credentialLabel: "Workboard key",
      envVars: ["WORKBOARD_KEY", "ALTERNATIVE_KEY"],
      getCredentialValue: () => undefined,
      setCredentialValue: () => {},
      createTool: () => null,
    },
  });
  const config: OpenClawConfig = {
    plugins: { entries: { workboard: { enabled: true, config: { apiKey: value } } } },
  };
  if (unresolved) {
    const path = "plugins.entries.workboard.config.apiKey";
    setConfigResolutionFacts(
      config,
      createConfigResolutionFacts(
        [{ configPath: path, varName: "WORKBOARD_KEY" }],
        new Map([[path, "WORKBOARD_KEY"]]),
      ),
    );
  }
  const inspection = await withPluginRuntimeRegistryScope(registry, () => inspect({ config, env }));
  expect(inspection.credentials).toEqual([
    {
      path: ["plugins", "entries", "workboard", "config", "apiKey"],
      label: "Workboard key",
      envVars: ["WORKBOARD_KEY", "ALTERNATIVE_KEY"],
      status,
    },
  ]);
});

it("inspects tracked external provenance, pinned integrity, operator grants, and trust", async () => {
  communityMetadata({
    source: "clawhub",
    spec: "clawhub:community/plugin",
    resolvedSpec: "clawhub:community/plugin@1.2.3",
    clawhubPackage: "community/plugin",
    integrity: "sha512-primary",
    npmIntegrity: "sha512-secondary",
    clawpackSha256: "archive-digest",
    clawhubTrustDisposition: "review-required",
    clawhubTrustReasons: ["Install script"],
    clawhubTrustCheckedAt: "2026-08-25T00:00:00.000Z",
    clawhubTrustAcknowledgedAt: "2026-08-25T01:00:00.000Z",
    clawhubTrustPending: false,
    clawhubTrustStale: true,
  });

  const inspection = await inspect({
    config: {
      plugins: {
        entries: {
          "community-plugin": {
            enabled: false,
            hooks: { allowPromptInjection: false, allowConversationAccess: true },
            llm: { allowModelOverride: true },
          },
        },
      },
    },
    pluginId: "community-plugin",
  });

  expect(inspection).toMatchObject({
    plugin: { id: "community-plugin", name: "Community Plugin", enabled: false },
    source: {
      kind: "clawhub",
      spec: "clawhub:community/plugin@1.2.3",
      packageName: "community/plugin",
      integrity: "sha512-primary",
      integrityKind: "ssri",
    },
    grants: {
      hooks: {
        allowPromptInjection: { effective: false, configured: false },
        allowConversationAccess: { effective: true, configured: true },
      },
      llm: { allowModelOverride: true },
    },
    trust: {
      disposition: "review-required",
      reasons: ["Install script"],
      checkedAt: "2026-08-25T00:00:00.000Z",
      acknowledgedAt: "2026-08-25T01:00:00.000Z",
      pending: false,
      stale: true,
    },
  });
  expect(inspection.reviewToken).toBe(computeDeclaredSurfaceHash(inspection.declared));
});

it("does not misrepresent an npm SHA-1 shasum as pinned SHA-256 integrity", async () => {
  communityMetadata({
    source: "npm",
    shasum: "0123456789abcdef0123456789abcdef01234567",
    npmShasum: "fedcba9876543210fedcba9876543210fedcba987",
  });

  const inspection = await inspect({
    config: { plugins: { entries: { "community-plugin": { enabled: false } } } },
    pluginId: "community-plugin",
  });

  expect(inspection.source).toEqual({
    kind: "npm",
    packageName: "@openclaw/community-plugin",
  });
});

it("redacts credentials from the persisted resolved spec without changing the install record", async () => {
  const url = new URL("https://example.invalid/plugins/demo.git");
  url.username = "fixture-user";
  url.password = "fixture-password";
  url.searchParams.set("token", "fixture-token");
  url.searchParams.set("ref", "stable");
  const spec = `git:${url.href}`;
  const metadata = communityMetadata({ source: "git", resolvedSpec: spec });
  const inspection = await inspect({ pluginId: "community-plugin" });

  expect(inspection.source?.spec).toBe(
    "git:https://***:***@example.invalid/plugins/demo.git?token=***&ref=stable",
  );
  expect(metadata.index.installRecords["community-plugin"]?.resolvedSpec).toBe(spec);
});

it.each([false, true])(
  "inspects the pinned catalog candidate with npm available: %s",
  async (npm) => {
    mocks.metadata.mockReturnValue(emptyMetadataSnapshot());
    const entry = {
      ...hostedFeedDiffsEntry,
      install: {
        candidates: [
          ...hostedFeedDiffsEntry.install.candidates,
          ...(npm
            ? [
                {
                  sourceRef: "public-npm",
                  package: "@vendor/diffs-npm",
                  version: "1.2.3",
                  integrity: "sha512-bnBtLXBpbg==",
                },
              ]
            : []),
        ],
      },
    };
    mocks.officialCatalog.mockResolvedValue({ source: "hosted", entries: [entry] });

    const inspection = await inspect({ pluginId: "diffs" });

    expect(inspection).toMatchObject({
      plugin: {
        id: "diffs",
        name: "Diffs",
        origin: "official",
        installed: false,
        enabled: false,
      },
      source: {
        kind: "official-catalog",
        packageName: npm ? "@vendor/diffs-npm" : "@openclaw/diffs",
        spec: npm ? "@vendor/diffs-npm@1.2.3" : "clawhub:@openclaw/diffs@2026.6.11",
        integrity: npm ? "sha512-bnBtLXBpbg==" : expect.stringMatching(/^sha256-/),
        integrityKind: npm ? "ssri" : "sha256",
      },
      grants: {
        hooks: {
          allowPromptInjection: { effective: true },
          allowConversationAccess: { effective: false },
        },
      },
    });
    expect(inspection.reviewToken).toBe(computeDeclaredSurfaceHash(inspection.declared));
  },
);

it("rejects inspection ids absent from installed metadata and the official catalog", async () => {
  mocks.metadata.mockReturnValue(emptyMetadataSnapshot());

  await expect(inspect({ pluginId: "unknown" })).rejects.toMatchObject({
    kind: "invalid-request",
    message: 'Plugin "unknown" not found.',
  });
});
