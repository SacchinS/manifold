import { execFile as execFileCb, spawn } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, rm, access, realpath } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { addWorktree, removeWorktree, listWorktrees } from "./manager.js";

const execFile = promisify(execFileCb);

async function exists(p: string): Promise<boolean> {
  try {
    await access(p);
    return true;
  } catch {
    return false;
  }
}

async function main() {
  const root = await mkdtemp(path.join(tmpdir(), "manifold-worktree-smoke-"));
  const baseRepoPath = path.join(root, "base");
  await execFile("git", ["init", "-q", "-b", "main", baseRepoPath]);
  await execFile("git", ["config", "user.email", "smoke@manifold.test"], { cwd: baseRepoPath });
  await execFile("git", ["config", "user.name", "Manifold Smoke Test"], { cwd: baseRepoPath });
  await execFile("git", ["commit", "--allow-empty", "-q", "-m", "initial commit"], { cwd: baseRepoPath });

  // 1. Basic add + remove.
  const singlePath = path.join(root, "wt-single");
  await addWorktree({ baseRepoPath, worktreePath: singlePath, branchName: "component/single" });
  console.log("add: worktree dir exists?", await exists(singlePath));
  console.log(
    "add: registered with git?",
    (await listWorktrees(baseRepoPath)).includes(await realpath(singlePath)),
  );

  await removeWorktree({ baseRepoPath, worktreePath: singlePath });
  console.log("remove: worktree dir gone?", !(await exists(singlePath)));

  // 2. Concurrency: fire N adds at the same base repo in parallel and confirm
  // the serializing queue prevents git index-lock races.
  const N = 5;
  const concurrentPaths = Array.from({ length: N }, (_, i) => path.join(root, `wt-concurrent-${i}`));
  await Promise.all(
    concurrentPaths.map((p, i) =>
      addWorktree({ baseRepoPath, worktreePath: p, branchName: `component/concurrent-${i}` }),
    ),
  );
  const registered = await listWorktrees(baseRepoPath);
  const realConcurrentPaths = await Promise.all(concurrentPaths.map((p) => realpath(p)));
  const allPresent = realConcurrentPaths.every((p) => registered.includes(p));
  console.log(`concurrent add: all ${N} worktrees registered without racing?`, allPresent);

  await Promise.all(concurrentPaths.map((p) => removeWorktree({ baseRepoPath, worktreePath: p })));
  const afterRemove = await listWorktrees(baseRepoPath);
  const allGone = concurrentPaths.every((p) => !afterRemove.includes(p));
  console.log("concurrent remove: all cleaned up without racing?", allGone);

  // 3. devServerPid teardown: removeWorktree should kill a still-running
  // process before removing the worktree out from under it.
  const devServerWtPath = path.join(root, "wt-devserver");
  await addWorktree({ baseRepoPath, worktreePath: devServerWtPath, branchName: "component/devserver" });
  const fakeServer = spawn("sleep", ["100"], { stdio: "ignore" });
  await new Promise((r) => setTimeout(r, 100)); // let it actually start
  console.log("devServerPid: process alive before remove?", isAlive(fakeServer.pid!));

  await removeWorktree({ baseRepoPath, worktreePath: devServerWtPath, devServerPid: fakeServer.pid });
  await new Promise((r) => setTimeout(r, 100)); // give SIGTERM a moment
  console.log("devServerPid: process dead after remove?", !isAlive(fakeServer.pid!));
  console.log("devServerPid: worktree dir gone?", !(await exists(devServerWtPath)));

  await rm(root, { recursive: true, force: true });
  console.log("\nWorktree manager smoke test passed.");
}

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
