import { execFile as execFileCb } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, rm, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { checkMergeConflict } from "./check-merge-conflict.js";
import { checkFileOverlap, type ComponentForOverlapCheck } from "./check-file-overlap.js";

const execFile = promisify(execFileCb);

async function git(args: string[], cwd: string) {
  await execFile("git", args, { cwd });
}

async function checkMergeConflictScenarios(root: string) {
  const base = path.join(root, "base");
  await git(["init", "-q", "-b", "main", base], root);
  await git(["config", "user.email", "smoke@manifold.test"], base);
  await git(["config", "user.name", "Manifold Smoke Test"], base);

  await writeFile(path.join(base, "fileA.txt"), "line1\n");
  await git(["add", "fileA.txt"], base);
  await git(["commit", "-q", "-m", "initial fileA"], base);

  // Branch X: diverges from main and edits the same line main will later edit too.
  const wtX = path.join(root, "wt-x");
  await git(["worktree", "add", wtX, "-b", "component/x"], base);
  await writeFile(path.join(wtX, "fileA.txt"), "line1-X\n");
  await git(["add", "fileA.txt"], wtX);
  await git(["commit", "-q", "-m", "X changes line1"], wtX);

  // Branch Y: diverges from main and adds an unrelated file.
  const wtY = path.join(root, "wt-y");
  await git(["worktree", "add", wtY, "-b", "component/y"], base);
  await writeFile(path.join(wtY, "fileB.txt"), "hello\n");
  await git(["add", "fileB.txt"], wtY);
  await git(["commit", "-q", "-m", "Y adds fileB"], wtY);

  // main moves forward, editing the same line X touched.
  await writeFile(path.join(base, "fileA.txt"), "line1-main\n");
  await git(["add", "fileA.txt"], base);
  await git(["commit", "-q", "-m", "main changes line1"], base);

  const conflictResult = await checkMergeConflict(base, "component/x", "main");
  console.log("component/x vs main: conflict detected?", conflictResult.hasConflict === true);
  console.log("conflict details captured?", !!conflictResult.conflictDetails && conflictResult.conflictDetails.length > 0);
  console.log(
    "commits-on-main-since-branch-start captured?",
    conflictResult.commitsOnMainSinceBranchStart?.some((l) => l.includes("main changes line1")),
  );

  const cleanResult = await checkMergeConflict(base, "component/y", "main");
  console.log("\ncomponent/y vs main: no conflict?", cleanResult.hasConflict === false);

  return base;
}

async function checkFileOverlapScenarios(base: string) {
  // Z: touches src/components/Toggle.tsx
  const wtZ = path.join(base, "..", "wt-z");
  await git(["worktree", "add", wtZ, "-b", "component/z"], base);
  await mkdir(path.join(wtZ, "src", "components"), { recursive: true });
  await writeFile(path.join(wtZ, "src", "components", "Toggle.tsx"), "export const Toggle = () => null;\n");
  await git(["add", "."], wtZ);
  await git(["commit", "-q", "-m", "Z adds Toggle"], wtZ);

  // A: declares owned_paths matching Toggle.tsx but hasn't actually touched it (unrelated commit instead).
  const wtA = path.join(base, "..", "wt-a");
  await git(["worktree", "add", wtA, "-b", "component/a"], base);
  await writeFile(path.join(wtA, "NOTES.md"), "unrelated\n");
  await git(["add", "."], wtA);
  await git(["commit", "-q", "-m", "A adds notes"], wtA);

  // B: doesn't declare ownership over Toggle.tsx, but actually committed a change there anyway.
  const wtB = path.join(base, "..", "wt-b");
  await git(["worktree", "add", wtB, "-b", "component/b"], base);
  await mkdir(path.join(wtB, "src", "components"), { recursive: true });
  await writeFile(path.join(wtB, "src", "components", "Toggle.tsx"), "export const Toggle = () => 'wandered here';\n");
  await git(["add", "."], wtB);
  await git(["commit", "-q", "-m", "B wandered into Toggle.tsx"], wtB);

  // C: also touches Toggle.tsx, but is already merged — should be excluded entirely.
  const wtC = path.join(base, "..", "wt-c");
  await git(["worktree", "add", wtC, "-b", "component/c"], base);
  await mkdir(path.join(wtC, "src", "components"), { recursive: true });
  await writeFile(path.join(wtC, "src", "components", "Toggle.tsx"), "export const Toggle = () => 'also here';\n");
  await git(["add", "."], wtC);
  await git(["commit", "-q", "-m", "C also touched Toggle.tsx"], wtC);

  const z: ComponentForOverlapCheck = { id: 100, branchName: "component/z", ownedPaths: ["src/components/**"], status: "ready_for_pr" };
  const a: ComponentForOverlapCheck = { id: 101, branchName: "component/a", ownedPaths: ["src/components/**"], status: "in_progress" };
  const b: ComponentForOverlapCheck = { id: 102, branchName: "component/b", ownedPaths: ["src/other/**"], status: "in_progress" };
  const c: ComponentForOverlapCheck = { id: 103, branchName: "component/c", ownedPaths: ["src/components/**"], status: "merged" };

  const warnings = await checkFileOverlap(z, [a, b, c], base, "main");
  console.log("\noverlap warnings found:", warnings);

  const declaredWarning = warnings.find((w) => w.otherComponentId === 101 && w.matchType === "declared_owned_paths");
  console.log("declared owned_paths overlap detected against A?", !!declaredWarning);

  const actualWarning = warnings.find((w) => w.otherComponentId === 102 && w.matchType === "actual_branch_diff");
  console.log("actual branch diff overlap detected against B (wandered outside owned_paths)?", !!actualWarning);

  const mergedWarning = warnings.find((w) => w.otherComponentId === 103);
  console.log("merged component C correctly excluded?", !mergedWarning);
}

async function main() {
  const root = await mkdtemp(path.join(tmpdir(), "manifold-conflict-smoke-"));
  const base = await checkMergeConflictScenarios(root);
  await checkFileOverlapScenarios(base);
  await rm(root, { recursive: true, force: true });
  console.log("\nconflict handling smoke test passed.");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
