import { execFile as execFileCb } from "node:child_process";
import { promisify } from "node:util";
import path from "node:path";

const execFile = promisify(execFileCb);

// All add/remove calls against the same base repo are serialized through
// this queue (module 3 in manifold-handoff.md) so concurrent component
// launches/merges never race on the shared .git metadata. Operations
// against *different* base repos (different runs/target repos) are not
// serialized against each other.
const queues = new Map<string, Promise<void>>();

function enqueue<T>(key: string, task: () => Promise<T>): Promise<T> {
  const tail = queues.get(key) ?? Promise.resolve();
  const run = tail.then(task);
  queues.set(
    key,
    run.then(
      () => undefined,
      () => undefined,
    ),
  );
  return run;
}

function killIfAlive(pid: number): void {
  try {
    process.kill(pid, "SIGTERM");
  } catch (err) {
    // ESRCH = no such process, already dead. Anything else is worth knowing about.
    if ((err as NodeJS.ErrnoException).code !== "ESRCH") throw err;
  }
}

export interface AddWorktreeOptions {
  baseRepoPath: string;
  worktreePath: string;
  branchName: string;
}

export async function addWorktree({
  baseRepoPath,
  worktreePath,
  branchName,
}: AddWorktreeOptions): Promise<void> {
  const key = path.resolve(baseRepoPath);
  await enqueue(key, async () => {
    await execFile("git", ["worktree", "add", worktreePath, "-b", branchName], {
      cwd: baseRepoPath,
    });
  });
}

export interface RemoveWorktreeOptions {
  baseRepoPath: string;
  worktreePath: string;
  /** If a dev server is still running against this worktree (module 4's
   *  visual ask_human flow), pass its pid so it gets killed before the
   *  worktree is removed. Otherwise it leaks as an orphaned process. */
  devServerPid?: number | null;
  /** Force-remove even with uncommitted changes. Defaults to false —
   *  a dirty worktree failing to remove is a signal, not noise. */
  force?: boolean;
}

export async function removeWorktree({
  baseRepoPath,
  worktreePath,
  devServerPid,
  force = false,
}: RemoveWorktreeOptions): Promise<void> {
  const key = path.resolve(baseRepoPath);
  await enqueue(key, async () => {
    if (devServerPid) {
      killIfAlive(devServerPid);
    }
    const args = ["worktree", "remove", worktreePath];
    if (force) args.push("--force");
    await execFile("git", args, { cwd: baseRepoPath });
  });
}

export async function listWorktrees(baseRepoPath: string): Promise<string[]> {
  const { stdout } = await execFile("git", ["worktree", "list", "--porcelain"], {
    cwd: baseRepoPath,
  });
  return stdout
    .split("\n")
    .filter((line) => line.startsWith("worktree "))
    .map((line) => line.slice("worktree ".length));
}
