const { execFile } = require("child_process");
const path = require("path");
const { extractGitValue } = require("../../shared/command-parsing");
const { formatFailureText } = require("../../shared/error-text");

const GIT_COMMAND_TIMEOUT_MS = 2 * 60 * 1000;
const GIT_COMMAND_MAX_BUFFER_BYTES = 8 * 1024 * 1024;
const SUPPORTED_GIT_SUBCOMMANDS = new Set(["status", "pull", "push"]);

async function handleGitCommand(runtime, normalized) {
  const workspaceContext = await runtime.resolveWorkspaceContext(normalized, {
    replyToMessageId: normalized.messageId,
    missingWorkspaceText: "当前会话还未绑定项目。先发送 `/codex bind /绝对路径`。",
  });
  if (!workspaceContext) {
    return;
  }

  const { workspaceRoot } = workspaceContext;
  const rawValue = extractGitValue(normalized.text);
  if (!rawValue) {
    await runtime.sendInfoCardMessage({
      chatId: normalized.chatId,
      replyToMessageId: normalized.messageId,
      text: buildGitHelpText(workspaceRoot),
    });
    return;
  }

  const subcommand = parseGitSubcommand(rawValue);
  if (!SUPPORTED_GIT_SUBCOMMANDS.has(subcommand)) {
    await runtime.sendInfoCardMessage({
      chatId: normalized.chatId,
      replyToMessageId: normalized.messageId,
      text: [
        `不支持的 Git 命令：\`${rawValue}\``,
        "",
        buildGitHelpText(workspaceRoot),
      ].join("\n"),
      kind: "error",
    });
    return;
  }

  try {
    if (subcommand === "status") {
      await handleGitStatus(runtime, normalized, workspaceRoot);
      return;
    }
    if (subcommand === "pull") {
      await handleGitPull(runtime, normalized, workspaceRoot);
      return;
    }
    await handleGitPush(runtime, normalized, workspaceRoot);
  } catch (error) {
    await runtime.sendInfoCardMessage({
      chatId: normalized.chatId,
      replyToMessageId: normalized.messageId,
      text: formatFailureText(`Git ${subcommand} 失败`, error),
      kind: "error",
    });
  }
}

async function handleGitStatus(runtime, normalized, workspaceRoot) {
  const repo = await resolveGitRepository(workspaceRoot);
  const summary = await getRepositorySummary(repo);
  const statusOutput = await runGit(repo.root, ["status", "--short", "--branch", "--untracked-files=all"]);

  await runtime.sendInfoCardMessage({
    chatId: normalized.chatId,
    replyToMessageId: normalized.messageId,
    text: [
      `当前项目：\`${workspaceRoot}\``,
      `仓库根目录：\`${repo.root}\``,
      `当前分支：\`${summary.branch}\``,
      summary.upstream ? `上游分支：\`${summary.upstream}\`` : "上游分支：未设置",
      buildAheadBehindLine(summary),
      "",
      "```text",
      trimCommandOutput(statusOutput.stdout || "git status returned no output"),
      "```",
    ].filter(Boolean).join("\n"),
  });
}

async function handleGitPull(runtime, normalized, workspaceRoot) {
  const repo = await resolveGitRepository(workspaceRoot);
  const summaryBefore = await getRepositorySummary(repo);
  if (summaryBefore.hasChanges) {
    throw new Error("当前仓库有未提交改动，已拒绝执行 pull。请先执行 `/codex git push` 或手动清理工作区。");
  }

  const pullArgs = buildPullArgs(summaryBefore);
  const pullResult = await runGit(repo.root, pullArgs);
  const summaryAfter = await getRepositorySummary(repo);

  await runtime.sendInfoCardMessage({
    chatId: normalized.chatId,
    replyToMessageId: normalized.messageId,
    text: [
      `当前项目：\`${workspaceRoot}\``,
      `仓库根目录：\`${repo.root}\``,
      `当前分支：\`${summaryAfter.branch}\``,
      summaryAfter.upstream ? `上游分支：\`${summaryAfter.upstream}\`` : "上游分支：未设置",
      buildAheadBehindLine(summaryAfter),
      "",
      "```text",
      trimCommandOutput(combineGitOutput(pullResult)),
      "```",
    ].filter(Boolean).join("\n"),
    kind: "success",
  });
}

async function handleGitPush(runtime, normalized, workspaceRoot) {
  const repo = await resolveGitRepository(workspaceRoot);
  const summaryBefore = await getRepositorySummary(repo);
  ensurePushableBranch(summaryBefore.branch);

  let commitMessage = "";
  let commitHash = "";
  let commitOutput = "";

  if (summaryBefore.hasChanges) {
    await runGit(repo.root, ["add", "-A"]);
    const stagedEntries = await getStagedEntries(repo.root);
    if (stagedEntries.length) {
      commitMessage = buildAutoCommitMessage(stagedEntries, repo.repoName);
      const commitResult = await runGit(repo.root, ["commit", "-m", commitMessage]);
      commitOutput = combineGitOutput(commitResult);
      commitHash = (await runGit(repo.root, ["rev-parse", "--short", "HEAD"])).stdout.trim();
    }
  }

  const summaryForPush = await getRepositorySummary(repo);
  const pushArgs = buildPushArgs(summaryForPush);
  const pushResult = await runGit(repo.root, pushArgs);
  const summaryAfter = await getRepositorySummary(repo);

  const lines = [
    `当前项目：\`${workspaceRoot}\``,
    `仓库根目录：\`${repo.root}\``,
    `当前分支：\`${summaryAfter.branch}\``,
    summaryAfter.upstream ? `上游分支：\`${summaryAfter.upstream}\`` : "上游分支：未设置",
  ];

  if (commitMessage) {
    lines.push(`自动提交信息：\`${commitMessage}\``);
  } else {
    lines.push("自动提交信息：本次没有本地改动，无需提交。");
  }
  if (commitHash) {
    lines.push(`提交哈希：\`${commitHash}\``);
  }

  lines.push(buildAheadBehindLine(summaryAfter));

  if (commitOutput) {
    lines.push("", "**commit 输出**", "```text", trimCommandOutput(commitOutput), "```");
  }

  lines.push("", "**push 输出**", "```text", trimCommandOutput(combineGitOutput(pushResult)), "```");

  await runtime.sendInfoCardMessage({
    chatId: normalized.chatId,
    replyToMessageId: normalized.messageId,
    text: lines.filter(Boolean).join("\n"),
    kind: "success",
  });
}

async function resolveGitRepository(workspaceRoot) {
  const root = (await runGit(workspaceRoot, ["rev-parse", "--show-toplevel"])).stdout.trim();
  if (!root) {
    throw new Error("当前项目不是 Git 仓库。");
  }
  return {
    root,
    repoName: path.basename(root),
  };
}

async function getRepositorySummary(repo) {
  const branch = (await runGit(repo.root, ["rev-parse", "--abbrev-ref", "HEAD"])).stdout.trim() || "HEAD";
  const statusOutput = await runGit(repo.root, ["status", "--porcelain", "--untracked-files=all"]);
  const hasChanges = !!statusOutput.stdout.trim();
  const upstream = await resolveUpstream(repo.root);
  let aheadCount = 0;
  let behindCount = 0;
  if (upstream) {
    const aheadBehindOutput = await runGit(repo.root, ["rev-list", "--left-right", "--count", `HEAD...${upstream}`]);
    const counts = aheadBehindOutput.stdout.trim().split(/\s+/).map((value) => Number(value || 0));
    aheadCount = Number.isFinite(counts[0]) ? counts[0] : 0;
    behindCount = Number.isFinite(counts[1]) ? counts[1] : 0;
  }

  return {
    branch,
    upstream,
    hasChanges,
    aheadCount,
    behindCount,
  };
}

async function resolveUpstream(workspaceRoot) {
  try {
    const output = await runGit(workspaceRoot, ["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{upstream}"]);
    return output.stdout.trim();
  } catch {
    return "";
  }
}

async function getStagedEntries(workspaceRoot) {
  const output = await runGit(workspaceRoot, [
    "diff",
    "--cached",
    "--name-status",
    "--find-renames",
    "--no-ext-diff",
  ]);
  return parseNameStatus(output.stdout);
}

function parseNameStatus(rawOutput) {
  return String(rawOutput || "")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      const parts = line.split("\t");
      const rawStatus = String(parts[0] || "").trim();
      const status = rawStatus.charAt(0).toUpperCase();
      if (status === "R" || status === "C") {
        return {
          status,
          oldPath: String(parts[1] || "").trim(),
          newPath: String(parts[2] || "").trim(),
          path: String(parts[2] || parts[1] || "").trim(),
        };
      }
      return {
        status,
        path: String(parts[1] || "").trim(),
      };
    })
    .filter((entry) => entry.path);
}

function buildAutoCommitMessage(entries, repoName) {
  const normalizedEntries = Array.isArray(entries) ? entries.filter(Boolean) : [];
  if (!normalizedEntries.length) {
    return `update ${repoName}`;
  }

  if (normalizedEntries.length === 1) {
    const entry = normalizedEntries[0];
    if (entry.status === "A" || entry.status === "C") {
      return `add ${entry.path}`;
    }
    if (entry.status === "D") {
      return `remove ${entry.path}`;
    }
    if (entry.status === "R") {
      return `rename ${entry.oldPath} to ${entry.newPath}`;
    }
    return `update ${entry.path}`;
  }

  const counts = {
    add: 0,
    update: 0,
    remove: 0,
    rename: 0,
  };
  for (const entry of normalizedEntries) {
    if (entry.status === "A" || entry.status === "C") {
      counts.add += 1;
      continue;
    }
    if (entry.status === "D") {
      counts.remove += 1;
      continue;
    }
    if (entry.status === "R") {
      counts.rename += 1;
      continue;
    }
    counts.update += 1;
  }

  const scope = deriveCommitScope(normalizedEntries, repoName);
  const parts = [];
  if (counts.add > 0) {
    parts.push(`add ${formatFileCount(counts.add)}`);
  }
  if (counts.update > 0) {
    parts.push(`update ${formatFileCount(counts.update)}`);
  }
  if (counts.remove > 0) {
    parts.push(`remove ${formatFileCount(counts.remove)}`);
  }
  if (counts.rename > 0) {
    parts.push(`rename ${formatFileCount(counts.rename)}`);
  }
  return `update ${scope}: ${parts.join(", ")}`;
}

function deriveCommitScope(entries, repoName) {
  const topLevelNames = new Set();
  for (const entry of entries) {
    const value = String(entry.path || entry.newPath || entry.oldPath || "").trim();
    if (!value) {
      continue;
    }
    const topLevelName = value.split("/")[0];
    if (!topLevelName) {
      continue;
    }
    topLevelNames.add(topLevelName);
  }
  if (topLevelNames.size === 1) {
    return [...topLevelNames][0];
  }
  return repoName || "repo";
}

function formatFileCount(count) {
  return `${count} file${count === 1 ? "" : "s"}`;
}

function buildPullArgs(summary) {
  ensurePushableBranch(summary.branch);
  if (summary.upstream) {
    return ["pull", "--ff-only"];
  }
  return ["pull", "--ff-only", "origin", summary.branch];
}

function buildPushArgs(summary) {
  ensurePushableBranch(summary.branch);
  if (summary.upstream) {
    return ["push"];
  }
  return ["push", "-u", "origin", summary.branch];
}

function ensurePushableBranch(branch) {
  if (!branch || branch === "HEAD") {
    throw new Error("当前仓库处于 detached HEAD，无法自动 push。请先切换到分支。");
  }
}

function buildAheadBehindLine(summary) {
  if (!summary.upstream) {
    return "与远端关系：尚未设置上游分支";
  }
  return `与远端关系：ahead ${summary.aheadCount}, behind ${summary.behindCount}`;
}

function buildGitHelpText(workspaceRoot) {
  return [
    `当前项目：\`${workspaceRoot}\``,
    "",
    "可用命令：",
    "`/codex git status`",
    "`/codex git pull`",
    "`/codex git push`",
    "",
    "`/codex git push` 会自动执行：",
    "1. `git add -A`",
    "2. 按规则生成 commit message",
    "3. `git commit`",
    "4. `git push`",
    "",
    "`/codex git pull` 默认执行 `git pull --ff-only`，且工作区有未提交改动时会拒绝执行。",
  ].join("\n");
}

function parseGitSubcommand(rawValue) {
  return String(rawValue || "")
    .trim()
    .split(/\s+/)[0]
    .toLowerCase();
}

function combineGitOutput(result) {
  return [String(result.stdout || "").trim(), String(result.stderr || "").trim()].filter(Boolean).join("\n");
}

function trimCommandOutput(text) {
  const normalized = String(text || "").trim();
  if (!normalized) {
    return "(no output)";
  }
  const lines = normalized.split(/\r?\n/);
  if (lines.length <= 40) {
    return normalized;
  }
  return `${lines.slice(0, 40).join("\n")}\n...`;
}

function runGit(workspaceRoot, args) {
  return new Promise((resolve, reject) => {
    execFile("git", args, {
      cwd: workspaceRoot,
      timeout: GIT_COMMAND_TIMEOUT_MS,
      maxBuffer: GIT_COMMAND_MAX_BUFFER_BYTES,
    }, (error, stdout, stderr) => {
      if (error) {
        const message = formatGitErrorMessage(args, stdout, stderr, error);
        const wrapped = new Error(message);
        wrapped.cause = error;
        reject(wrapped);
        return;
      }
      resolve({
        stdout: String(stdout || ""),
        stderr: String(stderr || ""),
      });
    });
  });
}

function formatGitErrorMessage(args, stdout, stderr, error) {
  const lines = [];
  const command = ["git", ...args].join(" ");
  if (command) {
    lines.push(command);
  }
  const stdoutText = String(stdout || "").trim();
  const stderrText = String(stderr || "").trim();
  if (stderrText) {
    lines.push(stderrText);
  } else if (stdoutText) {
    lines.push(stdoutText);
  } else if (error?.message) {
    lines.push(error.message);
  }
  return lines.join(": ");
}

module.exports = {
  handleGitCommand,
};
