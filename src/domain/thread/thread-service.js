const { filterThreadsByWorkspaceRoot } = require("../../shared/workspace-paths");
const { extractRestoreThreadId, extractSwitchThreadId } = require("../../shared/command-parsing");
const codexMessageUtils = require("../../infra/codex/message-utils");

const THREAD_SOURCE_KINDS = new Set([
  "app",
  "cli",
  "vscode",
  "exec",
  "appServer",
  "subAgent",
  "subAgentReview",
  "subAgentCompact",
  "subAgentThreadSpawn",
  "subAgentOther",
  "unknown",
]);

async function resolveWorkspaceThreadState(runtime, {
  bindingKey,
  workspaceRoot,
  normalized,
  autoSelectThread = true,
}) {
  const threads = await refreshWorkspaceThreads(runtime, bindingKey, workspaceRoot, normalized);
  const storedThreadId = runtime.resolveThreadIdForBinding(bindingKey, workspaceRoot);
  const selectedThreadId = runtime.sessionStore.isThreadArchived(bindingKey, workspaceRoot, storedThreadId)
    ? ""
    : storedThreadId;
  if (storedThreadId && !selectedThreadId) {
    runtime.sessionStore.clearThreadIdForWorkspace(bindingKey, workspaceRoot);
  }
  const threadId = selectedThreadId || (autoSelectThread ? (threads[0]?.id || "") : "");
  if (!selectedThreadId && threadId) {
    runtime.sessionStore.setThreadIdForWorkspace(
      bindingKey,
      workspaceRoot,
      threadId,
      codexMessageUtils.buildBindingMetadata(normalized)
    );
  }
  if (threadId) {
    runtime.setThreadBindingKey(threadId, bindingKey);
    runtime.setThreadWorkspaceRoot(threadId, workspaceRoot);
  }
  return { threads, threadId, selectedThreadId };
}

async function ensureThreadAndSendMessage(runtime, { bindingKey, workspaceRoot, normalized, threadId }) {
  const codexParams = runtime.getCodexParamsForWorkspace(bindingKey, workspaceRoot);

  if (!threadId) {
    const createdThreadId = await createWorkspaceThread(runtime, {
      bindingKey,
      workspaceRoot,
      normalized,
    });
    console.log(`[codex-im] turn/start first message thread=${createdThreadId}`);
    await runtime.codex.sendUserMessage({
      threadId: createdThreadId,
      text: normalized.text,
      model: codexParams.model || null,
      effort: codexParams.effort || null,
      accessMode: runtime.config.defaultCodexAccessMode,
      workspaceRoot,
    });
    runtime.setThreadBindingKey(createdThreadId, bindingKey);
    runtime.setThreadWorkspaceRoot(createdThreadId, workspaceRoot);
    return createdThreadId;
  }

  try {
    await ensureThreadResumed(runtime, threadId);
    await runtime.codex.sendUserMessage({
      threadId,
      text: normalized.text,
      model: codexParams.model || null,
      effort: codexParams.effort || null,
      accessMode: runtime.config.defaultCodexAccessMode,
      workspaceRoot,
    });
    console.log(`[codex-im] turn/start ok workspace=${workspaceRoot} thread=${threadId}`);
    runtime.setThreadBindingKey(threadId, bindingKey);
    runtime.setThreadWorkspaceRoot(threadId, workspaceRoot);
    return threadId;
  } catch (error) {
    if (!shouldRecreateThread(error)) {
      throw error;
    }

    console.warn(`[codex-im] stale thread detected, recreating workspace thread: ${threadId}`);
    runtime.resumedThreadIds.delete(threadId);
    runtime.sessionStore.clearThreadIdForWorkspace(bindingKey, workspaceRoot);
    const recreatedThreadId = await createWorkspaceThread(runtime, {
      bindingKey,
      workspaceRoot,
      normalized,
    });
    console.log(`[codex-im] turn/start retry thread=${recreatedThreadId}`);
    await runtime.codex.sendUserMessage({
      threadId: recreatedThreadId,
      text: normalized.text,
      model: codexParams.model || null,
      effort: codexParams.effort || null,
      accessMode: runtime.config.defaultCodexAccessMode,
      workspaceRoot,
    });
    runtime.setThreadBindingKey(recreatedThreadId, bindingKey);
    runtime.setThreadWorkspaceRoot(recreatedThreadId, workspaceRoot);
    return recreatedThreadId;
  }
}

async function createWorkspaceThread(runtime, { bindingKey, workspaceRoot, normalized }) {
  const response = await runtime.codex.startThread({
    cwd: workspaceRoot,
  });
  console.log(`[codex-im] thread/start ok workspace=${workspaceRoot}`);

  const resolvedThreadId = codexMessageUtils.extractThreadId(response);
  if (!resolvedThreadId) {
    throw new Error("thread/start did not return a thread id");
  }

  runtime.sessionStore.setThreadIdForWorkspace(
    bindingKey,
    workspaceRoot,
    resolvedThreadId,
    codexMessageUtils.buildBindingMetadata(normalized)
  );
  runtime.resumedThreadIds.add(resolvedThreadId);
  runtime.setPendingThreadContext(resolvedThreadId, normalized);
  runtime.setThreadBindingKey(resolvedThreadId, bindingKey);
  runtime.setThreadWorkspaceRoot(resolvedThreadId, workspaceRoot);
  return resolvedThreadId;
}

async function ensureThreadResumed(runtime, threadId) {
  const normalizedThreadId = typeof threadId === "string" ? threadId.trim() : "";
  if (!normalizedThreadId || runtime.resumedThreadIds.has(normalizedThreadId)) {
    return null;
  }

  const response = await runtime.codex.resumeThread({ threadId: normalizedThreadId });
  runtime.resumedThreadIds.add(normalizedThreadId);
  console.log(`[codex-im] thread/resume ok thread=${normalizedThreadId}`);
  return response;
}

async function handleNewCommand(runtime, normalized) {
  const bindingKey = runtime.sessionStore.buildBindingKey(normalized);
  const workspaceRoot = runtime.resolveWorkspaceRootForBinding(bindingKey);
  if (!workspaceRoot) {
    await runtime.sendInfoCardMessage({
      chatId: normalized.chatId,
      replyToMessageId: normalized.messageId,
      text: "当前会话还未绑定项目。先发送 `/codex bind /绝对路径`。",
    });
    return;
  }

  try {
    const createdThreadId = await createWorkspaceThread(runtime, {
      bindingKey,
      workspaceRoot,
      normalized,
    });
    await runtime.sendInfoCardMessage({
      chatId: normalized.chatId,
      replyToMessageId: normalized.messageId,
      text: `已创建新线程并切换到它:\n${workspaceRoot}\n\nthread: ${createdThreadId}`,
    });
    await runtime.showStatusPanel(normalized, { replyToMessageId: normalized.messageId });
  } catch (error) {
    await runtime.sendInfoCardMessage({
      chatId: normalized.chatId,
      replyToMessageId: normalized.messageId,
      text: `创建新线程失败: ${error.message}`,
    });
  }
}

async function handleSwitchCommand(runtime, normalized) {
  const threadId = extractSwitchThreadId(normalized.text);
  if (!threadId) {
    await runtime.sendInfoCardMessage({
      chatId: normalized.chatId,
      replyToMessageId: normalized.messageId,
      text: "用法: `/codex switch <threadId>`",
    });
    return;
  }

  await switchThreadById(runtime, normalized, threadId, { replyToMessageId: normalized.messageId });
}

async function handleArchiveCommand(runtime, normalized) {
  const { threadId } = runtime.getCurrentThreadContext(normalized);
  if (!threadId) {
    await runtime.sendInfoCardMessage({
      chatId: normalized.chatId,
      replyToMessageId: normalized.messageId,
      text: "当前项目还没有可归档的线程。",
    });
    return;
  }

  await archiveThreadById(runtime, normalized, threadId, {
    replyToMessageId: normalized.messageId,
  });
}

async function handleArchivedThreadsCommand(runtime, normalized) {
  await showArchivedThreadPicker(runtime, normalized, {
    replyToMessageId: normalized.messageId,
  });
}

async function handleRestoreCommand(runtime, normalized) {
  const threadId = extractRestoreThreadId(normalized.text);
  if (!threadId) {
    await runtime.sendInfoCardMessage({
      chatId: normalized.chatId,
      replyToMessageId: normalized.messageId,
      text: "用法: `/codex restore <threadId>`",
    });
    return;
  }

  await restoreThreadById(runtime, normalized, threadId, {
    replyToMessageId: normalized.messageId,
  });
}

async function refreshWorkspaceThreads(runtime, bindingKey, workspaceRoot, normalized) {
  try {
    const threads = (await listCodexThreadsForWorkspace(runtime, workspaceRoot))
      .filter((thread) => !runtime.sessionStore.isThreadArchived(bindingKey, workspaceRoot, thread.id));
    const currentThreadId = runtime.sessionStore.getThreadIdForWorkspace(bindingKey, workspaceRoot);
    const shouldKeepCurrentThread = currentThreadId && runtime.resumedThreadIds.has(currentThreadId);
    const isCurrentThreadArchived = runtime.sessionStore.isThreadArchived(bindingKey, workspaceRoot, currentThreadId);
    if (
      currentThreadId
      && (isCurrentThreadArchived || (!shouldKeepCurrentThread && !threads.some((thread) => thread.id === currentThreadId)))
    ) {
      runtime.sessionStore.clearThreadIdForWorkspace(bindingKey, workspaceRoot);
    }
    return threads;
  } catch (error) {
    console.warn(`[codex-im] thread/list failed for workspace=${workspaceRoot}: ${error.message}`);
    return [];
  }
}

async function listCodexThreadsForWorkspace(runtime, workspaceRoot) {
  const allThreads = await listCodexThreadsPaginated(runtime);
  const sourceFiltered = allThreads.filter((thread) => isSupportedThreadSourceKind(thread?.sourceKind));
  return filterThreadsByWorkspaceRoot(sourceFiltered, workspaceRoot);
}

async function listCodexThreadsPaginated(runtime) {
  const allThreads = [];
  const seenThreadIds = new Set();
  let cursor = null;

  for (let page = 0; page < 10; page += 1) {
    const response = await runtime.codex.listThreads({
      cursor,
      limit: 200,
      sortKey: "updated_at",
    });
    const pageThreads = codexMessageUtils.extractThreadsFromListResponse(response);
    for (const thread of pageThreads) {
      if (seenThreadIds.has(thread.id)) {
        continue;
      }
      seenThreadIds.add(thread.id);
      allThreads.push(thread);
    }

    const nextCursor = codexMessageUtils.extractThreadListCursor(response);
    if (!nextCursor || nextCursor === cursor) {
      break;
    }
    cursor = nextCursor;
    if (pageThreads.length === 0) {
      break;
    }
  }

  return allThreads;
}

function describeWorkspaceStatus(runtime, threadId) {
  if (!threadId) {
    return { code: "idle", label: "空闲" };
  }
  if (runtime.pendingApprovalByThreadId.has(threadId)) {
    return { code: "approval", label: "等待授权" };
  }
  if (runtime.activeTurnIdByThreadId.has(threadId)) {
    return { code: "running", label: "运行中" };
  }
  return { code: "idle", label: "空闲" };
}

async function switchThreadById(runtime, normalized, threadId, { replyToMessageId } = {}) {
  const replyTarget = runtime.resolveReplyToMessageId(normalized, replyToMessageId);
  const { bindingKey, workspaceRoot } = runtime.getBindingContext(normalized);
  if (!workspaceRoot) {
    await runtime.sendInfoCardMessage({
      chatId: normalized.chatId,
      replyToMessageId: replyTarget,
      text: "当前会话还未绑定项目。先发送 `/codex bind /绝对路径`。",
    });
    return;
  }

  const currentThreadId = runtime.resolveThreadIdForBinding(bindingKey, workspaceRoot);
  if (currentThreadId && currentThreadId === threadId) {
    await runtime.sendInfoCardMessage({
      chatId: normalized.chatId,
      replyToMessageId: replyTarget,
      text: "已经是当前线程，无需切换。",
    });
    return;
  }

  const availableThreads = await refreshWorkspaceThreads(runtime, bindingKey, workspaceRoot, normalized);
  const selectedThread = availableThreads.find((thread) => thread.id === threadId) || null;
  if (!selectedThread) {
    await runtime.sendInfoCardMessage({
      chatId: normalized.chatId,
      replyToMessageId: replyTarget,
      text: "指定线程当前不可用，请刷新后重试。",
    });
    return;
  }

  const resolvedWorkspaceRoot = selectedThread.cwd || workspaceRoot;
  runtime.sessionStore.setActiveWorkspaceRoot(bindingKey, resolvedWorkspaceRoot);
  runtime.sessionStore.setThreadIdForWorkspace(
    bindingKey,
    resolvedWorkspaceRoot,
    threadId,
    codexMessageUtils.buildBindingMetadata(normalized)
  );
  runtime.setThreadBindingKey(threadId, bindingKey);
  runtime.setThreadWorkspaceRoot(threadId, resolvedWorkspaceRoot);
  runtime.resumedThreadIds.delete(threadId);
  await ensureThreadResumed(runtime, threadId);
  await runtime.showStatusPanel(normalized, { replyToMessageId: replyTarget });
}

async function showArchivedThreadPicker(runtime, normalized, { replyToMessageId, noticeText = "" } = {}) {
  const replyTarget = runtime.resolveReplyToMessageId(normalized, replyToMessageId);
  const { bindingKey, workspaceRoot } = runtime.getBindingContext(normalized);
  if (!workspaceRoot) {
    await runtime.sendInfoCardMessage({
      chatId: normalized.chatId,
      replyToMessageId: replyTarget,
      text: "当前会话还未绑定项目。先发送 `/codex bind /绝对路径`。",
    });
    return;
  }

  const threads = await listArchivedThreadsForWorkspace(runtime, bindingKey, workspaceRoot);
  if (!threads.length) {
    await runtime.sendInfoCardMessage({
      chatId: normalized.chatId,
      replyToMessageId: replyTarget,
      text: `当前项目：\`${workspaceRoot}\`\n\n还没有已归档线程。`,
    });
    return;
  }

  await runtime.sendInteractiveCard({
    chatId: normalized.chatId,
    replyToMessageId: replyTarget,
    card: runtime.buildArchivedThreadPickerCard({
      workspaceRoot,
      threads,
      noticeText,
    }),
  });
}

async function archiveThreadById(runtime, normalized, threadId, { replyToMessageId } = {}) {
  const replyTarget = runtime.resolveReplyToMessageId(normalized, replyToMessageId);
  const { bindingKey, workspaceRoot } = runtime.getBindingContext(normalized);
  const normalizedThreadId = typeof threadId === "string" ? threadId.trim() : "";
  if (!workspaceRoot) {
    await runtime.sendInfoCardMessage({
      chatId: normalized.chatId,
      replyToMessageId: replyTarget,
      text: "当前会话还未绑定项目。先发送 `/codex bind /绝对路径`。",
    });
    return;
  }
  if (!normalizedThreadId) {
    await runtime.sendInfoCardMessage({
      chatId: normalized.chatId,
      replyToMessageId: replyTarget,
      text: "未读取到线程 ID，请刷新后重试。",
    });
    return;
  }
  if (runtime.sessionStore.isThreadArchived(bindingKey, workspaceRoot, normalizedThreadId)) {
    await runtime.sendInfoCardMessage({
      chatId: normalized.chatId,
      replyToMessageId: replyTarget,
      text: "该线程已经归档，无需重复操作。",
    });
    return;
  }
  if (runtime.activeTurnIdByThreadId.has(normalizedThreadId)) {
    await runtime.sendInfoCardMessage({
      chatId: normalized.chatId,
      replyToMessageId: replyTarget,
      text: "该线程正在运行，先发送 `/codex stop` 后再归档。",
    });
    return;
  }
  if (runtime.pendingApprovalByThreadId.has(normalizedThreadId)) {
    await runtime.sendInfoCardMessage({
      chatId: normalized.chatId,
      replyToMessageId: replyTarget,
      text: "该线程正在等待授权，先处理审批后再归档。",
    });
    return;
  }

  const allThreads = await listCodexThreadsForWorkspace(runtime, workspaceRoot);
  const targetThread = allThreads.find((item) => item.id === normalizedThreadId) || null;
  if (!targetThread) {
    await runtime.sendInfoCardMessage({
      chatId: normalized.chatId,
      replyToMessageId: replyTarget,
      text: "指定线程当前不可用，请刷新后重试。",
    });
    return;
  }

  runtime.sessionStore.archiveThread(bindingKey, workspaceRoot, normalizedThreadId, targetThread);
  runtime.resumedThreadIds.delete(normalizedThreadId);
  runtime.cleanupThreadRuntimeState(normalizedThreadId);
  runtime.clearPendingReactionForThread(normalizedThreadId).catch((error) => {
    console.error(`[codex-im] failed to clear pending reaction while archiving thread: ${error.message}`);
  });

  const currentThreadId = runtime.resolveThreadIdForBinding(bindingKey, workspaceRoot);
  if (currentThreadId === normalizedThreadId) {
    const nextVisibleThread = allThreads.find((item) => (
      item.id !== normalizedThreadId
      && !runtime.sessionStore.isThreadArchived(bindingKey, workspaceRoot, item.id)
    )) || null;
    if (nextVisibleThread) {
      runtime.sessionStore.setThreadIdForWorkspace(
        bindingKey,
        workspaceRoot,
        nextVisibleThread.id,
        codexMessageUtils.buildBindingMetadata(normalized)
      );
    } else {
      runtime.sessionStore.clearThreadIdForWorkspace(bindingKey, workspaceRoot);
    }
  }

  await runtime.showStatusPanel(normalized, {
    replyToMessageId: replyTarget,
    noticeText: `已归档线程：${formatThreadNoticeLabel(targetThread)}`,
  });
}

async function restoreThreadById(
  runtime,
  normalized,
  threadId,
  { replyToMessageId, reopenArchivedList = false } = {}
) {
  const replyTarget = runtime.resolveReplyToMessageId(normalized, replyToMessageId);
  const { bindingKey, workspaceRoot } = runtime.getBindingContext(normalized);
  const normalizedThreadId = typeof threadId === "string" ? threadId.trim() : "";
  if (!workspaceRoot) {
    await runtime.sendInfoCardMessage({
      chatId: normalized.chatId,
      replyToMessageId: replyTarget,
      text: "当前会话还未绑定项目。先发送 `/codex bind /绝对路径`。",
    });
    return;
  }
  if (!normalizedThreadId) {
    await runtime.sendInfoCardMessage({
      chatId: normalized.chatId,
      replyToMessageId: replyTarget,
      text: "未读取到线程 ID，请刷新后重试。",
    });
    return;
  }

  const archivedThreads = runtime.sessionStore.getArchivedThreadsForWorkspace(bindingKey, workspaceRoot);
  const targetThread = archivedThreads.find((item) => item.id === normalizedThreadId) || null;
  if (!targetThread) {
    await runtime.sendInfoCardMessage({
      chatId: normalized.chatId,
      replyToMessageId: replyTarget,
      text: "该线程未归档，无需恢复。",
    });
    return;
  }

  runtime.sessionStore.restoreThread(bindingKey, workspaceRoot, normalizedThreadId);
  if (reopenArchivedList) {
    const remainingArchivedThreads = runtime.sessionStore.getArchivedThreadsForWorkspace(bindingKey, workspaceRoot);
    if (!remainingArchivedThreads.length) {
      await runtime.showStatusPanel(normalized, {
        replyToMessageId: replyTarget,
        noticeText: `已恢复线程：${formatThreadNoticeLabel(targetThread)}`,
      });
      return;
    }
    await showArchivedThreadPicker(runtime, normalized, {
      replyToMessageId: replyTarget,
      noticeText: `已恢复线程：${formatThreadNoticeLabel(targetThread)}`,
    });
    return;
  }

  await runtime.showStatusPanel(normalized, {
    replyToMessageId: replyTarget,
    noticeText: `已恢复线程：${formatThreadNoticeLabel(targetThread)}`,
  });
}

async function listArchivedThreadsForWorkspace(runtime, bindingKey, workspaceRoot) {
  const archivedThreads = runtime.sessionStore.getArchivedThreadsForWorkspace(bindingKey, workspaceRoot);
  if (!archivedThreads.length) {
    return [];
  }

  let liveThreads = [];
  try {
    liveThreads = await listCodexThreadsForWorkspace(runtime, workspaceRoot);
  } catch (error) {
    console.warn(`[codex-im] archived thread list failed for workspace=${workspaceRoot}: ${error.message}`);
  }
  const liveThreadById = new Map(liveThreads.map((thread) => [thread.id, thread]));

  return archivedThreads
    .map((thread) => {
      const liveThread = liveThreadById.get(thread.id) || null;
      return {
        id: thread.id,
        cwd: liveThread?.cwd || thread.cwd || workspaceRoot,
        title: liveThread?.title || thread.title || "",
        updatedAt: liveThread?.updatedAt || thread.updatedAt || 0,
        sourceKind: liveThread?.sourceKind || thread.sourceKind || "unknown",
        archivedAt: thread.archivedAt || "",
      };
    })
    .sort((left, right) => compareArchivedThreads(left, right));
}

function isSupportedThreadSourceKind(sourceKind) {
  const normalized = typeof sourceKind === "string" && sourceKind.trim() ? sourceKind.trim() : "unknown";
  return THREAD_SOURCE_KINDS.has(normalized);
}

function compareArchivedThreads(left, right) {
  const leftArchivedAt = Date.parse(left?.archivedAt || "") || 0;
  const rightArchivedAt = Date.parse(right?.archivedAt || "") || 0;
  if (rightArchivedAt !== leftArchivedAt) {
    return rightArchivedAt - leftArchivedAt;
  }
  return Number(right?.updatedAt || 0) - Number(left?.updatedAt || 0);
}

function formatThreadNoticeLabel(thread) {
  if (!thread) {
    return "未命名线程";
  }
  return thread.title || thread.id || "未命名线程";
}

function shouldRecreateThread(error) {
  const message = String(error?.message || "").toLowerCase();
  return message.includes("thread not found") || message.includes("unknown thread");
}

module.exports = {
  archiveThreadById,
  createWorkspaceThread,
  describeWorkspaceStatus,
  ensureThreadAndSendMessage,
  ensureThreadResumed,
  handleArchiveCommand,
  handleArchivedThreadsCommand,
  handleNewCommand,
  handleRestoreCommand,
  handleSwitchCommand,
  refreshWorkspaceThreads,
  resolveWorkspaceThreadState,
  restoreThreadById,
  showArchivedThreadPicker,
  switchThreadById,
};