const fs = require("fs");
const os = require("os");
const path = require("path");
const messageNormalizers = require("../presentation/message/normalizers");
const eventsRuntime = require("./codex-event-service");
const { formatFailureText } = require("../shared/error-text");
const { resolveEffectiveModelForEffort } = require("../shared/model-catalog");

const INCOMING_IMAGE_MERGE_WINDOW_MS = 2000;

async function onFeishuMessageEvent(runtime, event) {
  const normalized = messageNormalizers.normalizeFeishuMessageEvent(event, runtime.config);
  if (!normalized) {
    return;
  }

  const mergedNormalized = await maybeMergeFeishuAdjacentImageAndText(runtime, normalized);
  if (!mergedNormalized) {
    return;
  }

  return processFeishuMessageEvent(runtime, mergedNormalized);
}

async function processFeishuMessageEvent(runtime, normalized) {
  if (await runtime.dispatchTextCommand(normalized)) {
    return;
  }

  const workspaceContext = await runtime.resolveWorkspaceContext(normalized, {
    replyToMessageId: normalized.messageId,
    missingWorkspaceText: "当前会话还未绑定项目。先发送 `/codex bind /绝对路径`。",
  });
  if (!workspaceContext) {
    return;
  }
  const { bindingKey, workspaceRoot } = workspaceContext;
  const imageInputValidationText = validateImageInput(runtime, bindingKey, workspaceRoot, normalized);
  if (imageInputValidationText) {
    await runtime.sendInfoCardMessage({
      chatId: normalized.chatId,
      replyToMessageId: normalized.messageId,
      text: imageInputValidationText,
      kind: "error",
    });
    return;
  }

  const { threadId } = await runtime.resolveWorkspaceThreadState({
    bindingKey,
    workspaceRoot,
    normalized,
    autoSelectThread: true,
  });

  runtime.setPendingBindingContext(bindingKey, normalized);
  if (threadId) {
    runtime.setPendingThreadContext(threadId, normalized);
  }

  await runtime.addPendingReaction(bindingKey, normalized.messageId);

  try {
    const preparedNormalized = await attachFeishuMessageImages(runtime, normalized);
    const resolvedThreadId = await runtime.ensureThreadAndSendMessage({
      bindingKey,
      workspaceRoot,
      normalized: preparedNormalized,
      threadId,
    });
    runtime.movePendingReactionToThread(bindingKey, resolvedThreadId);
  } catch (error) {
    await runtime.clearPendingReactionForBinding(bindingKey);
    await runtime.sendInfoCardMessage({
      chatId: normalized.chatId,
      replyToMessageId: normalized.messageId,
      text: formatFailureText("处理失败", error),
    });
    throw error;
  }
}

async function maybeMergeFeishuAdjacentImageAndText(runtime, normalized) {
  const sourceKey = buildIncomingMessageSourceKey(normalized);
  if (!sourceKey) {
    return normalized;
  }

  const pendingEntry = runtime.pendingIncomingImageBySourceKey.get(sourceKey) || null;
  if (pendingEntry && hasExpiredIncomingImageEntry(pendingEntry)) {
    clearIncomingImageEntry(runtime, sourceKey);
  }

  const hasImages = Array.isArray(normalized.imageKeys) && normalized.imageKeys.length > 0;
  const hasText = typeof normalized.text === "string" && normalized.text.trim().length > 0;
  const isCommand = !!normalized.command;

  if (hasImages && !hasText) {
    bufferIncomingImageMessage(runtime, sourceKey, normalized);
    return null;
  }

  if (hasText && !isCommand) {
    const activePendingEntry = runtime.pendingIncomingImageBySourceKey.get(sourceKey) || null;
    if (activePendingEntry) {
      clearIncomingImageEntry(runtime, sourceKey);
      return mergeFeishuImageAndTextMessage(activePendingEntry.normalized, normalized);
    }
  }

  return normalized;
}

function bufferIncomingImageMessage(runtime, sourceKey, normalized) {
  clearIncomingImageEntry(runtime, sourceKey);

  const entry = {
    createdAt: Date.now(),
    normalized,
    timer: setTimeout(() => {
      clearIncomingImageEntry(runtime, sourceKey);
      processFeishuMessageEvent(runtime, normalized).catch((error) => {
        console.error(`[codex-im] failed to process buffered Feishu image message: ${error.message}`);
      });
    }, INCOMING_IMAGE_MERGE_WINDOW_MS),
  };
  runtime.pendingIncomingImageBySourceKey.set(sourceKey, entry);
}

function clearIncomingImageEntry(runtime, sourceKey) {
  const entry = runtime.pendingIncomingImageBySourceKey.get(sourceKey);
  if (!entry) {
    return;
  }
  clearTimeout(entry.timer);
  runtime.pendingIncomingImageBySourceKey.delete(sourceKey);
}

function hasExpiredIncomingImageEntry(entry) {
  return !entry || (Date.now() - Number(entry.createdAt || 0)) > INCOMING_IMAGE_MERGE_WINDOW_MS;
}

function mergeFeishuImageAndTextMessage(imageNormalized, textNormalized) {
  return {
    ...textNormalized,
    imageKeys: Array.isArray(imageNormalized.imageKeys) ? imageNormalized.imageKeys.slice() : [],
    imageSourceMessageId: imageNormalized.messageId,
  };
}

function buildIncomingMessageSourceKey(normalized) {
  const parts = [
    normalized?.provider,
    normalized?.workspaceId,
    normalized?.chatId,
    normalized?.threadKey,
    normalized?.senderId,
  ]
    .map((value) => (typeof value === "string" ? value.trim() : ""))
    .filter(Boolean);
  return parts.join(":");
}

function validateImageInput(runtime, bindingKey, workspaceRoot, normalized) {
  if (!Array.isArray(normalized?.imageKeys) || normalized.imageKeys.length === 0) {
    return "";
  }

  const availableCatalog = runtime.sessionStore.getAvailableModelCatalog();
  const availableModels = Array.isArray(availableCatalog?.models) ? availableCatalog.models : [];
  if (!availableModels.length) {
    return "";
  }

  const codexParams = runtime.getCodexParamsForWorkspace(bindingKey, workspaceRoot);
  const currentModel = String(codexParams?.model || runtime.config.defaultCodexModel || "").trim();
  const effectiveModel = resolveEffectiveModelForEffort(availableModels, currentModel);
  const inputModalities = Array.isArray(effectiveModel?.inputModalities)
    ? effectiveModel.inputModalities.map((item) => String(item || "").trim().toLowerCase()).filter(Boolean)
    : [];
  if (!inputModalities.length || inputModalities.includes("image")) {
    return "";
  }

  return `当前模型 \`${effectiveModel.model}\` 不支持图片输入。请先切换到支持图片的模型，再发送图文消息。`;
}

async function attachFeishuMessageImages(runtime, normalized) {
  const imageKeys = Array.isArray(normalized?.imageKeys) ? normalized.imageKeys.filter(Boolean) : [];
  if (!imageKeys.length) {
    return normalized;
  }

  const imageSourceMessageId = String(normalized.imageSourceMessageId || normalized.messageId || "").trim();
  const localImagePaths = [];
  for (const [index, imageKey] of imageKeys.entries()) {
    const { buffer, headers } = await runtime.downloadMessageResource({
      messageId: imageSourceMessageId,
      fileKey: imageKey,
      type: "image",
    });
    const filePath = await writeFeishuImageToTempFile(imageSourceMessageId, index, buffer, headers);
    localImagePaths.push(filePath);
  }

  return {
    ...normalized,
    localImagePaths,
  };
}

async function writeFeishuImageToTempFile(messageId, index, buffer, headers) {
  if (!Buffer.isBuffer(buffer) || buffer.length <= 0) {
    throw new Error("下载图片失败：飞书返回了空内容");
  }

  const directoryPath = path.join(os.tmpdir(), "codex-im-images");
  await fs.promises.mkdir(directoryPath, { recursive: true });
  const extension = resolveImageExtension(headers);
  const normalizedMessageId = String(messageId || "message").replace(/[^a-zA-Z0-9_-]/g, "_");
  const filePath = path.join(directoryPath, `${normalizedMessageId}-${Date.now()}-${index}${extension}`);
  await fs.promises.writeFile(filePath, buffer);
  return filePath;
}

function resolveImageExtension(headers) {
  const contentType = resolveHeaderValue(headers, "content-type").toLowerCase().split(";")[0].trim();
  const contentTypeToExtension = {
    "image/jpeg": ".jpg",
    "image/png": ".png",
    "image/webp": ".webp",
    "image/gif": ".gif",
    "image/tiff": ".tiff",
    "image/bmp": ".bmp",
    "image/x-icon": ".ico",
    "image/vnd.microsoft.icon": ".ico",
  };
  return contentTypeToExtension[contentType] || ".img";
}

function resolveHeaderValue(headers, headerName) {
  if (!headers) {
    return "";
  }

  if (typeof headers.get === "function") {
    return String(headers.get(headerName) || headers.get(headerName.toLowerCase()) || "");
  }

  const direct = headers[headerName] ?? headers[headerName.toLowerCase()];
  if (Array.isArray(direct)) {
    return String(direct[0] || "");
  }
  return direct == null ? "" : String(direct);
}

async function onFeishuCardAction(runtime, data) {
  try {
    return await runtime.handleCardAction(data);
  } catch (error) {
    console.error(`[codex-im] failed to process card action: ${error.message}`);
    return runtime.buildCardToast(formatFailureText("处理失败", error));
  }
}

function onCodexMessage(runtime, message) {
  eventsRuntime.handleCodexMessage(runtime, message);
}

module.exports = {
  onCodexMessage,
  onFeishuCardAction,
  onFeishuMessageEvent,
  onFeishuTextEvent: onFeishuMessageEvent,
};
