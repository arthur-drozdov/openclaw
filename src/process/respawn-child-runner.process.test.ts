import { spawn, spawnSync } from "node:child_process";
import { once } from "node:events";
import { expect, it } from "vitest";
import { resolveTestNodeExecPath } from "../test-utils/node-process.js";

it.each([false, true])(
  "respawn parent channel preserves natural exit and ends orphan work (busy=%s)",
  async (busy) => {
    const source = `
    import { watchCliRespawnParent } from ${JSON.stringify(new URL("../../node-runtime-recovery.mjs", import.meta.url).href)};
    watchCliRespawnParent();
    process.send("ready");
    ${busy ? "setInterval(() => {}, 1000);" : ""}
  `;
    const child = spawn(resolveTestNodeExecPath(), ["--input-type=module", "-e", source], {
      stdio: ["ignore", "pipe", "pipe", "ipc"],
    });
    const closed = once(child, "close");
    try {
      const ready = await once(child, "message");
      expect(ready[0]).toBe("ready");
      if (busy) {
        child.disconnect();
      }
      expect(await closed).toEqual(busy ? [null, "SIGKILL"] : [0, null]);
    } finally {
      if (child.exitCode === null && child.signalCode === null) {
        child.kill("SIGKILL");
      }
      await closed;
    }
  },
);

it.runIf(process.platform !== "win32").each([
  { owner: "entry", signal: true },
  { owner: "entry", signal: false },
  { owner: "launcher", signal: true },
  { owner: "launcher", signal: false },
])(
  "preserves real $owner child-only signal versus numeric completion (signal=$signal)",
  ({ owner, signal }) => {
    const child = signal
      ? "process.stdout.write('settled-output', () => process.kill(process.pid, 'SIGKILL'));"
      : "process.stdout.write('settled-output'); process.exitCode = 143;";
    const source =
      owner === "entry"
        ? "import {spawn} from 'node:child_process';" +
          "import {attachChildProcessBridge} from " +
          JSON.stringify(new URL("./child-process-bridge.ts", import.meta.url).href) +
          ";" +
          "import {runRespawnChildWithSignalBridge} from " +
          JSON.stringify(new URL("./respawn-child-runner.ts", import.meta.url).href) +
          ";" +
          "process.exitCode = await runRespawnChildWithSignalBridge({command:process.execPath,args:['-e'," +
          JSON.stringify(child) +
          "],env:{},runtime:{spawn,attachChildProcessBridge},onError:console.error});"
        : "import {runRespawnedChild} from " +
          JSON.stringify(new URL("../../node-runtime-recovery.mjs", import.meta.url).href) +
          ";" +
          "await runRespawnedChild(process.execPath,['-e'," +
          JSON.stringify(child) +
          "],{});";
    const result = spawnSync(
      process.execPath,
      ["--import", import.meta.resolve("tsx"), "--input-type=module", "-e", source],
      {
        encoding: "utf8",
        timeout: 10_000,
      },
    );
    expect(result.error).toBeUndefined();
    expect(result.stdout).toBe("settled-output");
    expect({ code: result.status, signal: result.signal }, result.stderr).toEqual(
      signal ? { code: null, signal: "SIGKILL" } : { code: 143, signal: null },
    );
  },
);
