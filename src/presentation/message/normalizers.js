const codexMessageUtils = require("../../infra/codex/message-utils");

function normalizeFeishuMessageEvent(event, config) {
  const message = event?.message || {};
  const sender = event?.sender || {};
  const parsedMessage = parseFeishuIncomingMessage(message);
  if (!parsedMessage) {
    return null;
  }

  return {
    provider: "feishu",
    workspaceId: config.defaultWorkspaceId,
    chatId: message.chat_id || "",
    threadKey: message.root_id || "",
    senderId: sender?.sender_id?.open_id || sender?.sender_id?.user_id || "",
    messageId: message.message_id || "",
    messageType: normalizeIdentifier(message.message_type),
    text: parsedMessage.text,
    imageKeys: parsedMessage.imageKeys,
    command: parsedMessage.imageKeys.length > 0 ? "" : parseCommand(parsedMessage.text),
    receivedAt: new Date().toISOString(),
  };
}

function extractCardAction(data) {
  const action = data?.action || {};
  const value = action.value || {};
  if (!value.kind) {
    console.log("[codex-im] card callback action missing kind", {
      action,
      hasValue: !!action.value,
    });
    return null;
  }

  if (value.kind === "panel") {
    const selectedValue = extractCardSelectedValue(action, value);
    return {
      kind: value.kind,
      action: value.action || "",
      selectedValue,
    };
  }
  if (value.kind === "thread") {
    return {
      kind: value.kind,
      action: value.action || "",
      threadId: value.threadId || "",
    };
  }
  if (value.kind === "workspace") {
    return {
      kind: value.kind,
      action: value.action || "",
      workspaceRoot: value.workspaceRoot || "",
    };
  }
  return null;
}

function normalizeCardActionContext(data, config) {
  const messageId = normalizeIdentifier(data?.context?.open_message_id);
  const chatId = extractCardChatId(data);
  const senderId = normalizeIdentifier(data?.operator?.open_id);

  if (!chatId || !messageId || !senderId) {
    console.log("[codex-im] card callback missing required context", {
      context_open_message_id: data?.context?.open_message_id,
      context_open_chat_id: data?.context?.open_chat_id,
      operator_open_id: data?.operator?.open_id,
    });
    return null;
  }

  return {
    provider: "feishu",
    workspaceId: config.defaultWorkspaceId,
    chatId,
    threadKey: "",
    senderId,
    messageId,
    text: "",
    command: "",
    receivedAt: new Date().toISOString(),
  };
}

function mapCodexMessageToImEvent(message) {
  return codexMessageUtils.mapCodexMessageToImEvent(message);
}

function parseFeishuIncomingMessage(message) {
  const messageType = normalizeIdentifier(message?.message_type).toLowerCase();
  if (!messageType) {
    return null;
  }

  if (messageType === "text") {
    const text = parseFeishuMessageText(message.content);
    return text ? { text, imageKeys: [] } : null;
  }

  if (messageType === "image") {
    const imageKey = parseFeishuImageMessageKey(message.content);
    return imageKey ? { text: "", imageKeys: [imageKey] } : null;
  }

  if (messageType === "post") {
    return parseFeishuPostMessage(message.content);
  }

  return null;
}

function parseFeishuMessageText(rawContent) {
  try {
    const parsed = JSON.parse(rawContent || "{}");
    return typeof parsed.text === "string" ? parsed.text.trim() : "";
  } catch {
    return "";
  }
}

function parseFeishuImageMessageKey(rawContent) {
  try {
    const parsed = JSON.parse(rawContent || "{}");
    return normalizeIdentifier(parsed?.image_key);
  } catch {
    return "";
  }
}

function parseFeishuPostMessage(rawContent) {
  let parsed;
  try {
    parsed = JSON.parse(rawContent || "{}");
  } catch {
    return null;
  }

  const postContent = resolveFeishuPostContent(parsed);
  if (!postContent) {
    return null;
  }

  const imageKeys = [];
  const lines = [];
  const title = normalizeIdentifier(postContent.title);
  if (title) {
    lines.push(title);
  }

  const paragraphs = Array.isArray(postContent.content) ? postContent.content : [];
  for (const paragraph of paragraphs) {
    if (!Array.isArray(paragraph) || !paragraph.length) {
      continue;
    }

    const parts = [];
    for (const node of paragraph) {
      if (!node || typeof node !== "object") {
        continue;
      }

      const tag = normalizeIdentifier(node.tag).toLowerCase();
      if (!tag) {
        continue;
      }

      if (tag === "img") {
        const imageKey = normalizeIdentifier(node.image_key);
        if (imageKey) {
          imageKeys.push(imageKey);
        }
        continue;
      }

      const text = stringifyFeishuPostNode(node, tag);
      if (text) {
        parts.push(text);
      }
    }

    const line = parts.join("").trim();
    if (line) {
      lines.push(line);
    }
  }

  const uniqueImageKeys = [];
  const seenImageKeys = new Set();
  for (const imageKey of imageKeys) {
    if (seenImageKeys.has(imageKey)) {
      continue;
    }
    seenImageKeys.add(imageKey);
    uniqueImageKeys.push(imageKey);
  }

  const text = lines.join("\n").trim();
  if (!text && !uniqueImageKeys.length) {
    return null;
  }

  return {
    text,
    imageKeys: uniqueImageKeys,
  };
}

function resolveFeishuPostContent(parsed) {
  if (!parsed || typeof parsed !== "object") {
    return null;
  }

  if (Array.isArray(parsed.content)) {
    return parsed;
  }

  const localeKeys = ["zh_cn", "en_us", "ja_jp"];
  for (const localeKey of localeKeys) {
    if (parsed[localeKey] && Array.isArray(parsed[localeKey].content)) {
      return parsed[localeKey];
    }
  }

  for (const value of Object.values(parsed)) {
    if (value && typeof value === "object" && Array.isArray(value.content)) {
      return value;
    }
  }

  return null;
}

function stringifyFeishuPostNode(node, tag) {
  if (tag === "text") {
    return normalizeIdentifier(node.text);
  }

  if (tag === "a") {
    const text = normalizeIdentifier(node.text);
    const href = normalizeIdentifier(node.href);
    if (text && href) {
      return `${text} (${href})`;
    }
    return text || href;
  }

  if (tag === "at") {
    const displayName = normalizeIdentifier(node.user_name);
    const userId = normalizeIdentifier(node.user_id);
    if (displayName) {
      return `@${displayName}`;
    }
    if (userId === "all") {
      return "@all";
    }
    return userId ? `@${userId}` : "";
  }

  if (tag === "code_block") {
    const code = normalizeIdentifier(node.text);
    const language = normalizeIdentifier(node.language);
    return code ? `\`\`\`${language}\n${code}\n\`\`\`` : "";
  }

  if (tag === "md") {
    return normalizeIdentifier(node.text);
  }

  if (tag === "emotion") {
    const emojiType = normalizeIdentifier(node.emoji_type);
    return emojiType ? `:${emojiType}:` : "";
  }

  if (tag === "hr") {
    return "\n---\n";
  }

  if (tag === "media") {
    return "[视频]";
  }

  return "";
}

function parseCommand(text) {
  const normalized = text.trim().toLowerCase();
  const prefixes = ["/codex "];
  const exactPrefixes = ["/codex"];

  const exactCommands = {
    archive: ["archive"],
    archived: ["archived"],
    stop: ["stop"],
    where: ["where"],
    inspect_message: ["message"],
    help: ["help"],
    workspace: ["workspace"],
    remove: ["remove"],
    restore: ["restore"],
    send: ["send"],
    switch: ["switch"],
    new: ["new"],
    model: ["model"],
    effort: ["effort"],
    git: ["git"],
    approve: ["approve", "approve workspace"],
    reject: ["reject"],
  };

  for (const [command, suffixes] of Object.entries(exactCommands)) {
    if (matchesExactCommand(normalized, suffixes)) {
      return command;
    }
  }

  if (matchesPrefixCommand(normalized, "switch")) {
    return "switch";
  }
  if (matchesPrefixCommand(normalized, "restore")) {
    return "restore";
  }
  if (matchesPrefixCommand(normalized, "remove")) {
    return "remove";
  }
  if (matchesPrefixCommand(normalized, "send")) {
    return "send";
  }
  if (matchesPrefixCommand(normalized, "bind")) {
    return "bind";
  }
  if (matchesPrefixCommand(normalized, "model")) {
    return "model";
  }
  if (matchesPrefixCommand(normalized, "effort")) {
    return "effort";
  }
  if (matchesPrefixCommand(normalized, "git")) {
    return "git";
  }
  if (prefixes.some((prefix) => normalized.startsWith(prefix))) {
    return "unknown_command";
  }
  if (exactPrefixes.includes(normalized)) {
    return "unknown_command";
  }
  if (text.trim()) {
    return "message";
  }

  return "";
}

function matchesExactCommand(text, suffixes) {
  return suffixes.some((suffix) => text === `/codex ${suffix}`);
}

function matchesPrefixCommand(text, command) {
  return text.startsWith(`/codex ${command} `);
}

function extractCardChatId(data) {
  return normalizeIdentifier(data?.context?.open_chat_id);
}

function extractCardSelectedValue(action, value) {
  if (typeof action?.option?.value === "string" && action.option.value.trim()) {
    return action.option.value.trim();
  }
  if (typeof action?.option === "string" && action.option.trim()) {
    return action.option.trim();
  }
  return typeof value?.selectedValue === "string" ? value.selectedValue.trim() : "";
}

function normalizeIdentifier(value) {
  return typeof value === "string" && value.trim() ? value.trim() : "";
}

module.exports = {
  extractCardAction,
  mapCodexMessageToImEvent,
  normalizeCardActionContext,
  normalizeFeishuMessageEvent,
  normalizeFeishuTextEvent: normalizeFeishuMessageEvent,
};
