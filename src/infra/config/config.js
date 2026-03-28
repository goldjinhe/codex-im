const path = require("path");
const os = require("os");

const TRUE_ENV_VALUES = new Set(["1", "true", "yes", "on"]);
const FALSE_ENV_VALUES = new Set(["0", "false", "no", "off"]);
const ALLOWED_ACCESS_MODES = new Set(["default", "full-access"]);

function readConfig() {
  const mode = process.argv[2] || "";

  return {
    mode,
    workspaceAllowlist: readListEnv("CODEX_IM_WORKSPACE_ALLOWLIST"),
    codexEndpoint: process.env.CODEX_IM_CODEX_ENDPOINT || "",
    codexCommand: process.env.CODEX_IM_CODEX_COMMAND || "",
    defaultCodexModel: readTextEnv("CODEX_IM_DEFAULT_CODEX_MODEL"),
    defaultCodexEffort: readTextEnv("CODEX_IM_DEFAULT_CODEX_EFFORT"),
    defaultCodexAccessMode: readAccessModeEnv("CODEX_IM_DEFAULT_CODEX_ACCESS_MODE"),
    feishu: {
      appId: process.env.FEISHU_APP_ID || "",
      appSecret: process.env.FEISHU_APP_SECRET || "",
      verificationToken: readTextEnv("FEISHU_VERIFICATION_TOKEN"),
      encryptKey: readTextEnv("FEISHU_ENCRYPT_KEY"),
      cardCallbackHost: readTextEnv("CODEX_IM_FEISHU_CARD_CALLBACK_HOST") || "127.0.0.1",
      cardCallbackPort: readPortEnv("CODEX_IM_FEISHU_CARD_CALLBACK_PORT", 3333),
      cardCallbackPath: readHttpPathEnv("CODEX_IM_FEISHU_CARD_CALLBACK_PATH", "/webhook/card"),
    },
    defaultWorkspaceId: process.env.CODEX_IM_DEFAULT_WORKSPACE_ID || "default",
    feishuStreamingOutput: readBooleanEnv("CODEX_IM_FEISHU_STREAMING_OUTPUT", true),
    sessionsFile: process.env.CODEX_IM_SESSIONS_FILE
      || path.join(os.homedir(), ".codex-im", "sessions.json"),
  };
}

function readListEnv(name) {
  return String(process.env[name] || "")
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
}

function readBooleanEnv(name, defaultValue) {
  const rawValue = process.env[name];
  if (typeof rawValue !== "string" || !rawValue.trim()) {
    return defaultValue;
  }

  const normalized = rawValue.trim().toLowerCase();
  if (TRUE_ENV_VALUES.has(normalized)) {
    return true;
  }
  if (FALSE_ENV_VALUES.has(normalized)) {
    return false;
  }
  return defaultValue;
}

function readTextEnv(name) {
  const value = process.env[name];
  return typeof value === "string" ? value.trim() : "";
}

function readAccessModeEnv(name) {
  const value = readTextEnv(name).toLowerCase();
  return ALLOWED_ACCESS_MODES.has(value) ? value : "";
}

function readPortEnv(name, defaultValue) {
  const rawValue = readTextEnv(name);
  if (!rawValue) {
    return defaultValue;
  }

  const parsed = Number.parseInt(rawValue, 10);
  if (!Number.isInteger(parsed) || parsed <= 0 || parsed > 65535) {
    return defaultValue;
  }
  return parsed;
}

function readHttpPathEnv(name, defaultValue) {
  const rawValue = readTextEnv(name);
  if (!rawValue) {
    return defaultValue;
  }
  return rawValue.startsWith("/") ? rawValue : `/${rawValue}`;
}

module.exports = { readConfig };
