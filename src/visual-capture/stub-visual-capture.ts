import { spawn } from "node:child_process";
import { writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { findFreePort, isAlive } from "../util/process.js";
import type { EnsureDevServerInput, EnsureDevServerResult, ScreenshotInput, VisualCapture } from "./types.js";

// Stub stand-in for the real Playwright + dev-server implementation. Instead
// of actually booting the worktree's app, it spawns a harmless placeholder
// process so port/pid bookkeeping (module 4, and worktree teardown in
// module 3) can be built and tested against something real without needing
// an actual target app yet.
export class StubVisualCapture implements VisualCapture {
  async ensureDevServer({ existingPort, existingPid }: EnsureDevServerInput): Promise<EnsureDevServerResult> {
    if (existingPort && existingPid && isAlive(existingPid)) {
      return { port: existingPort, pid: existingPid };
    }

    const port = await findFreePort();
    const child = spawn("sleep", ["3600"], { stdio: "ignore", detached: true });
    child.unref();
    if (!child.pid) throw new Error("failed to spawn stub dev server");
    return { port, pid: child.pid };
  }

  async screenshot({ port }: ScreenshotInput): Promise<string> {
    const dir = path.join(tmpdir(), "manifold-screenshots");
    await mkdir(dir, { recursive: true });
    const filePath = path.join(dir, `stub-${port}-${Date.now()}.txt`);
    await writeFile(filePath, `stub screenshot placeholder for port ${port}\n`);
    return filePath;
  }
}
