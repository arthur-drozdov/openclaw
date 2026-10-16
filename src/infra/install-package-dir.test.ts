import fsSync from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../test/helpers/promise.js";
import { withPluginLifecycleLease } from "../plugins/plugin-lifecycle-lease.js";
import { runCommandWithTimeout, type CommandOptions, type SpawnResult } from "../process/exec.js";
import { closeOpenClawStateDatabaseForTest } from "../state/openclaw-state-db.js";
import { createSuiteTempRootTracker } from "../test-helpers/temp-dir.js";
import { expectedNpmCommand } from "../test-utils/npm-command.js";
import {
  copyPackageDirInstallTransactionRequest,
  installPackageDir,
  requestDeferredPackageDirInstall,
  resolvePackageDirInstallTransaction,
} from "./install-package-dir.js";
import {
  createExistingInstallFixture,
  listMatchingDirs,
  normalizeComparablePath,
  updateOptions,
} from "./install-package-dir.test-support.js";

const npmSuccess: SpawnResult = {
  stdout: "",
  stderr: "",
  code: 0,
  signal: null,
  killed: false,
  termination: "exit",
};

vi.mock("../process/exec.js", async () => {
  const actual = await vi.importActual<typeof import("../process/exec.js")>("../process/exec.js");
  return {
    ...actual,
    runCommandWithTimeout: vi.fn(actual.runCommandWithTimeout),
  };
});

async function listMatchingEntries(root: string, prefix: string): Promise<string[]> {
  const entries = await fs.readdir(root, { withFileTypes: true });
  const names: string[] = [];
  for (const entry of entries) {
    if (entry.name.startsWith(prefix)) {
      names.push(entry.name);
    }
  }
  return names;
}

async function expectMissingPath(filePath: string): Promise<void> {
  try {
    await fs.stat(filePath);
  } catch (error) {
    expect((error as NodeJS.ErrnoException).code).toBe("ENOENT");
    return;
  }
  throw new Error(`Expected missing path: ${filePath}`);
}

function expectRunCommandCallForArgv(
  expectedArgv: string[],
  predicate?: (options: CommandOptions) => boolean,
): CommandOptions {
  const calls = vi.mocked(runCommandWithTimeout).mock.calls as [
    string[],
    number | CommandOptions,
  ][];
  for (const [argv, optionsOrTimeout] of calls.toReversed()) {
    if (
      JSON.stringify(argv) !== JSON.stringify(expectedArgv) ||
      typeof optionsOrTimeout === "number"
    ) {
      continue;
    }
    if (!predicate || predicate(optionsOrTimeout)) {
      return optionsOrTimeout;
    }
  }
  throw new Error(`Expected runCommandWithTimeout call: ${expectedArgv.join(" ")}`);
}

async function rebindInstallBasePath(params: {
  installBaseDir: string;
  preservedDir: string;
  outsideTarget: string;
}): Promise<void> {
  await fs.rename(params.installBaseDir, params.preservedDir);
  await fs.symlink(
    params.outsideTarget,
    params.installBaseDir,
    process.platform === "win32" ? "junction" : undefined,
  );
}

async function addHardlinkedFile(filePath: string, linkPath: string): Promise<void> {
  await fs.mkdir(path.dirname(linkPath), { recursive: true });
  await fs.link(filePath, linkPath);
}

async function createReboundInstallFixture(params: {
  fixtureRoot: string;
  withExistingInstall?: boolean;
}) {
  const sourceDir = path.join(params.fixtureRoot, "source");
  const installBaseDir = path.join(params.fixtureRoot, "plugins");
  const preservedInstallRoot = path.join(params.fixtureRoot, "plugins-preserved");
  const outsideInstallRoot = path.join(params.fixtureRoot, "outside-plugins");
  const targetDir = path.join(installBaseDir, "demo");
  await fs.mkdir(sourceDir, { recursive: true });
  await fs.mkdir(installBaseDir, { recursive: true });
  await fs.mkdir(outsideInstallRoot, { recursive: true });
  if (params.withExistingInstall) {
    await fs.mkdir(targetDir, { recursive: true });
    await fs.writeFile(path.join(targetDir, "marker.txt"), "old");
  }
  await fs.writeFile(path.join(sourceDir, "marker.txt"), "new");
  return { installBaseDir, outsideInstallRoot, preservedInstallRoot, sourceDir, targetDir };
}

async function expectText(directory: string, expected: string, name = "marker.txt") {
  await expect(fs.readFile(path.join(directory, name), "utf8")).resolves.toBe(expected);
}

describe("installPackageDir", () => {
  const fixtureRootTracker = createSuiteTempRootTracker({
    prefix: "openclaw-install-package-dir-",
  });
  async function createFixture(name: string) {
    await fixtureRootTracker.setup();
    const fixtureRoot = await fixtureRootTracker.make(name);
    return { fixtureRoot, ...(await createExistingInstallFixture(fixtureRoot)) };
  }

  async function createSourceFixture() {
    await fixtureRootTracker.setup();
    const fixtureRoot = await fixtureRootTracker.make("case");
    const sourceDir = path.join(fixtureRoot, "source");
    const targetDir = path.join(fixtureRoot, "plugins", "demo");
    await fs.mkdir(sourceDir, { recursive: true });
    return { fixtureRoot, sourceDir, targetDir };
  }

  async function writeManifest(sourceDir: string) {
    await fs.writeFile(
      path.join(sourceDir, "package.json"),
      JSON.stringify({
        name: "demo-plugin",
        version: "1.0.0",
        dependencies: { zod: "^4.0.0" },
      }),
      "utf-8",
    );
  }

  async function installWithNpmResult(
    npmResult: SpawnResult | Promise<SpawnResult>,
    activity?: import("./install-progress.js").InstallActivityObserver["activity"],
  ) {
    const { sourceDir, targetDir } = await createSourceFixture();
    await writeManifest(sourceDir);
    vi.mocked(runCommandWithTimeout).mockImplementation(() => Promise.resolve(npmResult));

    return await installPackageDir({
      ...updateOptions(sourceDir, targetDir),
      mode: "install",
      hasDeps: true,
      depsLogMessage: "Installing deps…",
      logger: { activity },
    });
  }

  afterEach(async () => {
    vi.restoreAllMocks();
    await fixtureRootTracker.cleanup();
  });

  it.each([0, 1])(
    "reports dependency settlement only after npm finishes with code %s",
    async (code) => {
      const pending = createDeferred<SpawnResult>();
      const events: import("../../packages/gateway-protocol/src/schema/plugins.js").PluginInstallActivity[] =
        [];
      const install = installWithNpmResult(pending.promise, (event) => {
        events.push(event);
      });
      try {
        await vi.waitFor(() =>
          expect(events).toContainEqual(
            expect.objectContaining({ stage: "dependencies", status: "started" }),
          ),
        );
        expect(events.map(({ stage, status }) => [stage, status])).toEqual([
          ["files", "started"],
          ["files", "completed"],
          ["dependencies", "started"],
        ]);
      } finally {
        pending.resolve({
          code,
          stdout: "",
          stderr: code ? "registry refused dependency" : "",
          signal: null,
          killed: false,
          termination: "exit",
        });
        await install;
      }
      const result = await install;
      expect(result.ok).toBe(code === 0);
      expect(events.at(-1)).toEqual({ ...events[2], status: code === 0 ? "completed" : "failed" });
      if (!result.ok) {
        expect(result.error).toContain("registry refused dependency");
      }
    },
  );

  it("keeps the existing install in place when staged validation fails", async () => {
    const { installBaseDir, sourceDir, targetDir } = await createFixture("case");

    const result = await installPackageDir({
      ...updateOptions(sourceDir, targetDir),
      depsLogMessage: "Installing deps…",
      afterCopy: async (installedDir) => {
        expect(installedDir).not.toBe(targetDir);
        await expectText(installedDir, "new");
        throw new Error("validation boom");
      },
    });

    expect(result).toEqual({
      ok: false,
      error: "post-copy validation failed: Error: validation boom",
    });
    await expectText(targetDir, "old");
    await expect(
      listMatchingDirs(installBaseDir, ".openclaw-install-stage-"),
    ).resolves.toHaveLength(0);
    await expect(
      listMatchingDirs(installBaseDir, ".openclaw-install-backups"),
    ).resolves.toHaveLength(0);
  });

  it("checks update authority before displacing the existing install", async () => {
    const { sourceDir, targetDir } = await createFixture("case");
    let backupReached = false;
    const result = await installPackageDir({
      ...updateOptions(sourceDir, targetDir),
      depsLogMessage: "unused",
      beforePersistentApply() {
        throw new Error("update authority closed");
      },
      async afterBackup() {
        backupReached = true;
        return { ok: true };
      },
    });

    expect(result).toEqual({
      ok: false,
      error: "failed to copy plugin: Error: update authority closed",
    });
    expect(backupReached).toBe(false);
    await expectText(targetDir, "old");
  });

  it("restores edits detected after the existing install moves to backup", async () => {
    const { installBaseDir, sourceDir, targetDir } = await createFixture("case");

    const result = await installPackageDir({
      ...updateOptions(sourceDir, targetDir),
      depsLogMessage: "Installing deps…",
      afterBackup: async (backupDir) => {
        await fs.writeFile(path.join(backupDir, "local.txt"), "keep me");
        return { ok: false, error: "existing install changed" };
      },
    });

    expect(result).toEqual({ ok: false, error: "existing install changed" });
    await expectText(targetDir, "old");
    await expectText(targetDir, "keep me", "local.txt");
    await expect(
      listMatchingDirs(installBaseDir, ".openclaw-install-stage-"),
    ).resolves.toHaveLength(0);
    await expect(
      fs.readdir(path.join(installBaseDir, ".openclaw-install-backups")),
    ).resolves.toHaveLength(0);
  });

  it("restores the original without publishing when authority closes during move preparation", async () => {
    const { installBaseDir, sourceDir, targetDir } = await createFixture("publication-authority");
    const owner = new AbortController();
    const assertPublicationAuthority = () => owner.signal.throwIfAborted();
    const paused = createDeferred();
    const release = createDeferred();
    const targetPath = normalizeComparablePath(targetDir);
    const revokedTargetContents: string[] = [];
    let stageDir = "";
    let backupDir = "";
    let pauseConsumed = false;

    const realOpendir = fs.opendir.bind(fs);
    vi.spyOn(fs, "opendir").mockImplementation(async (...args: Parameters<typeof fs.opendir>) => {
      const directory = await realOpendir(...args);
      if (!pauseConsumed && backupDir && String(args[0]) === stageDir) {
        pauseConsumed = true;
        paused.resolve();
        await release.promise;
      }
      return directory;
    });
    const realRename = fs.rename.bind(fs);
    vi.spyOn(fs, "rename").mockImplementation((...args: Parameters<typeof fs.rename>) => {
      if (owner.signal.aborted && normalizeComparablePath(String(args[1])) === targetPath) {
        revokedTargetContents.push(
          fsSync.readFileSync(path.join(String(args[0]), "marker.txt"), "utf8"),
        );
      }
      return realRename(...args);
    });

    const params = {
      ...updateOptions(sourceDir, targetDir),
      depsLogMessage: "Installing deps…",
      beforePersistentApply: assertPublicationAuthority,
      afterInstall: async (installedDir: string) => {
        assertPublicationAuthority();
        stageDir = installedDir;
        return { ok: true as const };
      },
      afterBackup: async (installedDir: string) => {
        backupDir = installedDir;
        return { ok: true as const };
      },
    };
    const installing = installPackageDir(params);
    try {
      await Promise.race([
        paused.promise,
        installing.then(() => {
          throw new Error("install completed before staged publication paused");
        }),
      ]);
      expect(pauseConsumed).toBe(true);
      expect(backupDir).not.toBe("");
      await expectText(backupDir, "old");
      await expectMissingPath(targetDir);
      owner.abort(new Error("publication authority revoked"));
      expect(assertPublicationAuthority).toThrow("publication authority revoked");
      release.resolve();
      const result = await installing;

      // Restoring the old bytes remains allowed after forward authority closes.
      expect.soft(revokedTargetContents).not.toContain("new");
      expect.soft(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error).toContain("publication authority revoked");
      }
      await expectText(targetDir, "old");
      await expect(
        listMatchingDirs(installBaseDir, ".openclaw-install-stage-"),
      ).resolves.toHaveLength(0);
      await expect(listMatchingDirs(installBaseDir, ".fs-safe-move-")).resolves.toHaveLength(0);
      await expect(
        fs.readdir(path.join(installBaseDir, ".openclaw-install-backups")),
      ).resolves.toHaveLength(0);
    } finally {
      release.resolve();
      await installing;
    }
  });

  it.runIf(process.platform !== "win32")(
    "updates package-manager installs that contain hardlinked package files",
    async () => {
      const { fixtureRoot, sourceDir, targetDir } = await createFixture("case");
      await addHardlinkedFile(
        path.join(targetDir, "marker.txt"),
        path.join(fixtureRoot, "cache", "existing-marker.txt"),
      );

      vi.mocked(runCommandWithTimeout).mockImplementation(async (_argv, optionsOrTimeout) => {
        const cwd = typeof optionsOrTimeout === "number" ? undefined : optionsOrTimeout.cwd;
        if (cwd === undefined) {
          throw new Error("expected staged package install cwd");
        }
        const depFile = path.join(cwd, "node_modules", "demo-dep", "index.js");
        await fs.mkdir(path.dirname(depFile), { recursive: true });
        await fs.writeFile(depFile, "module.exports = 1;\n", "utf8");
        await addHardlinkedFile(depFile, path.join(fixtureRoot, "cache", "staged-dep.js"));
        return npmSuccess;
      });

      const result = await installPackageDir({
        ...updateOptions(sourceDir, targetDir),
        hasDeps: true,
        sourceHardlinks: "package-manager",
        depsLogMessage: "Installing deps…",
      });

      expect(result).toEqual({ ok: true });
      await expectText(targetDir, "new");
      await expect(
        fs.lstat(path.join(targetDir, "node_modules", "demo-dep", "index.js")),
      ).resolves.toMatchObject({ nlink: 2 });
    },
  );

  it.runIf(process.platform !== "win32")(
    "requires explicit package-manager hardlink allowance for dependency installs",
    async () => {
      const { fixtureRoot, sourceDir, targetDir } = await createFixture("case");
      await addHardlinkedFile(
        path.join(targetDir, "marker.txt"),
        path.join(fixtureRoot, "cache", "existing-marker.txt"),
      );

      vi.mocked(runCommandWithTimeout).mockResolvedValue(npmSuccess);

      const result = await installPackageDir({
        ...updateOptions(sourceDir, targetDir),
        hasDeps: true,
        depsLogMessage: "Installing deps…",
      });

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error).toContain("Refusing to move hardlinked file");
      }
      await expectText(targetDir, "old");
    },
  );

  it.runIf(process.platform !== "win32")(
    "keeps hardlinked staged installs rejected for dependency-free publishes",
    async () => {
      const { fixtureRoot, sourceDir, targetDir } = await createSourceFixture();
      await fs.writeFile(path.join(sourceDir, "marker.txt"), "new");

      const result = await installPackageDir({
        ...updateOptions(sourceDir, targetDir),
        mode: "install",
        depsLogMessage: "Installing deps…",
        afterCopy: async (installedDir) => {
          await addHardlinkedFile(
            path.join(installedDir, "marker.txt"),
            path.join(fixtureRoot, "cache", "staged-marker.txt"),
          );
        },
      });

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error).toContain("Refusing to move hardlinked file");
      }
      await expectMissingPath(path.join(targetDir, "marker.txt"));
    },
  );

  it("aborts without outside writes when the install base is rebound before publish", async () => {
    await fixtureRootTracker.setup();
    const fixtureRoot = await fixtureRootTracker.make("case");
    const { installBaseDir, outsideInstallRoot, preservedInstallRoot, sourceDir, targetDir } =
      await createReboundInstallFixture({ fixtureRoot });

    const warnings: string[] = [];
    let rebound = false;
    const result = await installPackageDir({
      ...updateOptions(sourceDir, targetDir),
      mode: "install",
      depsLogMessage: "Installing deps…",
      logger: { warn: (message) => warnings.push(message) },
      afterInstall: async (installedDir) => {
        await expectText(installedDir, "new");
        await rebindInstallBasePath({
          installBaseDir,
          preservedDir: preservedInstallRoot,
          outsideTarget: outsideInstallRoot,
        });
        rebound = true;
        return { ok: true };
      },
    });

    expect(rebound).toBe(true);
    expect((await fs.lstat(installBaseDir)).isSymbolicLink()).toBe(true);
    expect(result).toEqual({
      ok: false,
      error: "failed to copy plugin: Error: install base directory changed during install",
    });
    await expectMissingPath(path.join(outsideInstallRoot, "demo", "marker.txt"));
    await expect(fs.readdir(outsideInstallRoot)).resolves.toEqual([]);
    expect(warnings).toContain(
      "Install base directory changed during install; aborting staged publish.",
    );
  });

  it("warns and leaves the backup in place when the install base changes before backup cleanup", async () => {
    await fixtureRootTracker.setup();
    const fixtureRoot = await fixtureRootTracker.make("case");
    const { installBaseDir, outsideInstallRoot, preservedInstallRoot, sourceDir, targetDir } =
      await createReboundInstallFixture({ fixtureRoot, withExistingInstall: true });

    const warnings: string[] = [];
    const installBasePath = normalizeComparablePath(installBaseDir);
    const realStat = fs.stat.bind(fs);
    let installBaseStatCalls = 0;
    vi.spyOn(fs, "stat").mockImplementation(async (...args: Parameters<typeof fs.stat>) => {
      if (normalizeComparablePath(String(args[0])) === installBasePath) {
        installBaseStatCalls += 1;
        if (installBaseStatCalls === 3) {
          await rebindInstallBasePath({
            installBaseDir,
            preservedDir: preservedInstallRoot,
            outsideTarget: outsideInstallRoot,
          });
        }
      }
      return await realStat(...args);
    });

    const result = await installPackageDir({
      ...updateOptions(sourceDir, targetDir),
      depsLogMessage: "Installing deps…",
      logger: { warn: (message) => warnings.push(message) },
    });

    expect(result).toEqual({ ok: true });
    expect(installBaseStatCalls).toBe(3);
    expect(warnings).toContain(
      "Install base directory changed before backup cleanup; leaving backup in place.",
    );
    await expectMissingPath(path.join(outsideInstallRoot, "demo", "marker.txt"));
    const backupRoot = path.join(preservedInstallRoot, ".openclaw-install-backups");
    await expect(fs.readdir(backupRoot)).resolves.toHaveLength(1);
  });

  it("hides the staged project .npmrc while npm install runs and restores it afterward", async () => {
    const { sourceDir, targetDir } = await createSourceFixture();
    const npmrcContent = "git=calc.exe\n";
    await writeManifest(sourceDir);
    await fs.writeFile(path.join(sourceDir, ".npmrc"), npmrcContent, "utf-8");

    vi.mocked(runCommandWithTimeout).mockImplementation(async (_argv, optionsOrTimeout) => {
      const cwd = typeof optionsOrTimeout === "number" ? undefined : optionsOrTimeout.cwd;
      if (cwd === undefined) {
        throw new Error("expected package install cwd");
      }
      await expectMissingPath(path.join(cwd, ".npmrc"));
      await expect(
        listMatchingEntries(cwd, ".openclaw-install-hidden-npmrc-"),
      ).resolves.toHaveLength(1);
      return npmSuccess;
    });

    const result = await installPackageDir({
      ...updateOptions(sourceDir, targetDir),
      mode: "install",
      hasDeps: true,
      depsLogMessage: "Installing deps…",
    });

    expect(result).toEqual({ ok: true });
    await expectText(targetDir, npmrcContent, ".npmrc");
    await expect(
      listMatchingEntries(targetDir, ".openclaw-install-hidden-npmrc-"),
    ).resolves.toHaveLength(0);
  });

  it("forces dependency installs to stay project-local when npm global config leaks in", async () => {
    const { fixtureRoot, sourceDir, targetDir } = await createSourceFixture();
    await writeManifest(sourceDir);

    vi.stubEnv("NPM_CONFIG_GLOBAL", "true");
    vi.stubEnv("npm_config_global", "true");
    vi.stubEnv("NPM_CONFIG_LOCATION", "global");
    vi.stubEnv("npm_config_location", "global");
    vi.stubEnv("NPM_CONFIG_PREFIX", path.join(fixtureRoot, "global-prefix-uppercase"));
    vi.stubEnv("npm_config_prefix", path.join(fixtureRoot, "global-prefix"));
    vi.mocked(runCommandWithTimeout).mockResolvedValue(npmSuccess);

    const result = await installPackageDir({
      ...updateOptions(sourceDir, targetDir),
      mode: "install",
      hasDeps: true,
      depsLogMessage: "Installing deps…",
    });

    expect(result).toEqual({ ok: true });
    const installOptions = expectRunCommandCallForArgv(
      expectedNpmCommand([
        "install",
        "--omit=dev",
        "--loglevel=error",
        "--ignore-scripts",
        "--workspaces=false",
      ]),
      (options) => options.env?.npm_config_global === "false",
    );
    const env = installOptions.env ?? {};
    expect(env.npm_config_global).toBe("false");
    expect(env.npm_config_location).toBe("project");
    expect(env.npm_config_package_lock).toBe("false");
    expect(env.npm_config_save).toBe("false");
    expect("NPM_CONFIG_GLOBAL" in env).toBe(false);
    expect("NPM_CONFIG_LOCATION" in env).toBe(false);
    expect("NPM_CONFIG_PREFIX" in env).toBe(false);
    expect("npm_config_prefix" in env).toBe(false);
  });

  it.each(["exit", "throw"] as const)(
    "restores manifest bytes before cleanup and preserves the old install on npm %s failure",
    async (failure) => {
      const { sourceDir, targetDir } = await createSourceFixture();
      await fs.writeFile(
        path.join(sourceDir, "package.json"),
        JSON.stringify({
          name: "demo-plugin",
          version: "1.0.0",
          dependencies: {
            bad: "workspace:^",
          },
          devDependencies: {
            openclaw: "2026.6.1",
          },
        }),
        "utf-8",
      );

      const originalManifest = await fs.readFile(path.join(sourceDir, "package.json"));
      const oldManifest = '{"name":"demo-plugin","version":"0.9.0"}\n';
      await fs.mkdir(targetDir, { recursive: true });
      await fs.writeFile(path.join(targetDir, "package.json"), oldManifest);
      let stagedDir = "";
      let restoredBeforeCleanup = false;
      const realRm = fs.rm.bind(fs);
      vi.spyOn(fs, "rm").mockImplementation(async (...args: Parameters<typeof fs.rm>) => {
        if (String(args[0]) === stagedDir) {
          expect(await fs.readFile(path.join(stagedDir, "package.json"))).toEqual(originalManifest);
          restoredBeforeCleanup = true;
        }
        return await realRm(...args);
      });

      // Mirrors the Blacksmith repro: npm 11 preserved this stderr with
      // `--loglevel=error`, while `--silent` returned empty output.
      vi.mocked(runCommandWithTimeout).mockResolvedValue({
        stdout: "",
        stderr:
          'npm error code EUNSUPPORTEDPROTOCOL\nnpm error Unsupported URL Type "workspace:": workspace:^\n',
        code: 1,
        signal: null,
        killed: false,
        termination: "exit",
      });

      if (failure === "throw") {
        vi.mocked(runCommandWithTimeout).mockRejectedValue(new Error("npm transport failed"));
      }
      const result = await installPackageDir(
        requestDeferredPackageDirInstall({
          sourceDir,
          targetDir,
          mode: "update",
          timeoutMs: 1_000,
          copyErrorPrefix: "failed to copy plugin",
          hasDeps: true,
          omitOpenClawHostDependency: true,
          depsLogMessage: "Installing deps…",
          afterCopy: (dir: string) => {
            stagedDir = dir;
          },
        }),
      );

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error).toContain("npm install failed:");
        expect(result.error).toContain(
          failure === "exit" ? "EUNSUPPORTEDPROTOCOL" : "npm transport failed",
        );
      }
      expect(restoredBeforeCleanup).toBe(true);
      await expectText(targetDir, oldManifest, "package.json");
      await expect(fs.readFile(path.join(sourceDir, "package.json"))).resolves.toEqual(
        originalManifest,
      );
      await expectMissingPath(stagedDir);
    },
  );

  it("does not let a closed installer roll back under a successor's live lease", async () => {
    const { fixtureRoot, sourceDir, targetDir } = await createFixture("closed-installer");
    const leaseOptions = {
      path: path.join(fixtureRoot, "leases.sqlite"),
      leaseMs: 300_000,
      waitMs: 0,
    };
    const installOptions = updateOptions(sourceDir, targetDir);
    let originalBackup = "";

    try {
      const original = await withPluginLifecycleLease(leaseOptions, async (lease) => {
        const assertOwned = lease.assertOwned.bind(lease);
        const result = await installPackageDir(
          copyPackageDirInstallTransactionRequest(
            requestDeferredPackageDirInstall({}, assertOwned),
            {
              ...installOptions,
              afterBackup: async (backupDir: string) => {
                originalBackup = backupDir;
                return { ok: true as const };
              },
            },
          ),
        );
        expect(result.ok).toBe(true);
        const transaction = resolvePackageDirInstallTransaction(result);
        if (!transaction) {
          throw new Error("Expected a retained package transaction");
        }
        return { transaction, assertOwned };
      });
      expect(original.assertOwned).toThrow();
      await fs.writeFile(path.join(sourceDir, "marker.txt"), "successor");

      await withPluginLifecycleLease(leaseOptions, async (lease) => {
        // A's inode still matches, so only its copied lease can reject this rollback.
        await expect.soft(original.transaction.rollback()).rejects.toThrow();
        await expectText(targetDir, "new");
        expect((await installPackageDir(installOptions)).ok).toBe(true);
        lease.assertOwned();
        // The active async context is B's, but A's retained handle still owns A's lease.
        await expect.soft(original.transaction.rollback()).rejects.toThrow();
        await expectText(targetDir, "successor");
        await expectText(originalBackup, "old");
      });
    } finally {
      closeOpenClawStateDatabaseForTest();
    }
  });
});
