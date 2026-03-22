#!/usr/bin/env node

/**
 * WeChat Channel for Claude Code
 *
 * An MCP server that bridges personal WeChat messages to Claude Code
 * using WeChat's ilink bot protocol (same as the official Tencent OpenClaw plugin).
 *
 * Login: QR code scan with your WeChat app
 * Protocol: Long-poll getUpdates + sendMessage via ilinkai.weixin.qq.com
 */

import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  ListToolsRequestSchema,
  CallToolRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";

// ── Configuration ───────────────────────────────────────────────────────────

const DEFAULT_BASE_URL = "https://ilinkai.weixin.qq.com";
const ILINK_BOT_TYPE = "3";
const STATE_DIR = path.join(os.homedir(), ".claude", "wechat-channel");
const CREDENTIALS_PATH = path.join(STATE_DIR, "credentials.json");
const SYNC_BUF_PATH = path.join(STATE_DIR, "sync-buf.txt");
const ALLOWLIST_PATH = path.join(STATE_DIR, "allowlist.json");

const LONG_POLL_TIMEOUT_MS = 35_000;
const API_TIMEOUT_MS = 15_000;
const MAX_CONSECUTIVE_FAILURES = 5;
const BACKOFF_DELAY_MS = 30_000;
const RETRY_DELAY_MS = 2_000;

// ── Logging (to stderr so it doesn't interfere with MCP stdio) ──────────────

function log(...args) {
  console.error(`[wechat-channel]`, ...args);
}

// ── State ───────────────────────────────────────────────────────────────────

/** Credentials saved after QR login */
let credentials = loadCredentials();

/** Map of userId -> contextToken for reply routing */
const contextTokens = new Map();

/** Sender allowlist */
let allowlist = loadAllowlist();

/** Abort controller for the poll loop */
let pollAbort = null;

// ── Persistence helpers ─────────────────────────────────────────────────────

function ensureStateDir() {
  fs.mkdirSync(STATE_DIR, { recursive: true });
}

function loadCredentials() {
  try {
    if (fs.existsSync(CREDENTIALS_PATH)) {
      return JSON.parse(fs.readFileSync(CREDENTIALS_PATH, "utf-8"));
    }
  } catch {}
  return null;
}

function saveCredentials(creds) {
  ensureStateDir();
  fs.writeFileSync(CREDENTIALS_PATH, JSON.stringify(creds, null, 2), "utf-8");
  try { fs.chmodSync(CREDENTIALS_PATH, 0o600); } catch {}
}

function loadSyncBuf() {
  try {
    if (fs.existsSync(SYNC_BUF_PATH)) {
      return fs.readFileSync(SYNC_BUF_PATH, "utf-8").trim();
    }
  } catch {}
  return "";
}

function saveSyncBuf(buf) {
  ensureStateDir();
  fs.writeFileSync(SYNC_BUF_PATH, buf, "utf-8");
}

function loadAllowlist() {
  try {
    if (fs.existsSync(ALLOWLIST_PATH)) {
      return JSON.parse(fs.readFileSync(ALLOWLIST_PATH, "utf-8"));
    }
  } catch {}
  return [];
}

function saveAllowlist(list) {
  ensureStateDir();
  fs.writeFileSync(ALLOWLIST_PATH, JSON.stringify(list, null, 2), "utf-8");
}

// ── WeChat API helpers ──────────────────────────────────────────────────────

function randomWechatUin() {
  const uint32 = crypto.randomBytes(4).readUInt32BE(0);
  return Buffer.from(String(uint32), "utf-8").toString("base64");
}

function buildHeaders(token, body) {
  const headers = {
    "Content-Type": "application/json",
    AuthorizationType: "ilink_bot_token",
    "Content-Length": String(Buffer.byteLength(body, "utf-8")),
    "X-WECHAT-UIN": randomWechatUin(),
  };
  if (token) {
    headers.Authorization = `Bearer ${token}`;
  }
  return headers;
}

async function apiFetch({ baseUrl, endpoint, body, token, timeoutMs, label }) {
  const base = baseUrl.endsWith("/") ? baseUrl : `${baseUrl}/`;
  const url = new URL(endpoint, base).toString();
  const hdrs = buildHeaders(token, body);

  const controller = new AbortController();
  const t = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: hdrs,
      body,
      signal: controller.signal,
    });
    clearTimeout(t);
    const rawText = await res.text();
    if (!res.ok) {
      throw new Error(`${label} ${res.status}: ${rawText}`);
    }
    return rawText;
  } catch (err) {
    clearTimeout(t);
    throw err;
  }
}

// ── WeChat QR Login ─────────────────────────────────────────────────────────

async function fetchQRCode(apiBaseUrl) {
  const base = apiBaseUrl.endsWith("/") ? apiBaseUrl : `${apiBaseUrl}/`;
  const url = `${base}ilink/bot/get_bot_qrcode?bot_type=${ILINK_BOT_TYPE}`;
  log("Fetching QR code from:", url);
  const res = await fetch(url);
  if (!res.ok) {
    throw new Error(`Failed to fetch QR code: ${res.status} ${res.statusText}`);
  }
  return await res.json();
}

async function pollQRStatus(apiBaseUrl, qrcode) {
  const base = apiBaseUrl.endsWith("/") ? apiBaseUrl : `${apiBaseUrl}/`;
  const url = `${base}ilink/bot/get_qrcode_status?qrcode=${encodeURIComponent(qrcode)}`;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), LONG_POLL_TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      headers: { "iLink-App-ClientVersion": "1" },
      signal: controller.signal,
    });
    clearTimeout(timer);
    if (!res.ok) {
      throw new Error(`QR status poll failed: ${res.status}`);
    }
    return await res.json();
  } catch (err) {
    clearTimeout(timer);
    if (err.name === "AbortError") return { status: "wait" };
    throw err;
  }
}

/**
 * Start login: fetch QR code and return the URL immediately.
 * Polling for scan confirmation happens in the background.
 */
async function startLogin(baseUrl) {
  const qrResponse = await fetchQRCode(baseUrl);
  log("QR code received.");

  // Generate ASCII QR code to include in the tool response
  let qrAscii = "";
  try {
    const qrterm = await import("qrcode-terminal");
    qrAscii = await new Promise((resolve) => {
      qrterm.default.generate(qrResponse.qrcode_img_content, { small: true }, (qr) => {
        resolve(qr);
      });
    });
  } catch {
    log("Could not generate ASCII QR code");
  }

  // Start background polling for QR scan result
  pollLoginStatus(baseUrl, qrResponse.qrcode);

  return {
    qrUrl: qrResponse.qrcode_img_content,
    qrAscii,
    message: "QR code generated. Scan with WeChat to login.",
  };
}

/**
 * Background polling loop that waits for QR scan confirmation.
 * Sends channel notifications on status changes.
 */
async function pollLoginStatus(baseUrl, qrcode) {
  const deadline = Date.now() + 480_000;
  let maxRefreshes = 3;
  let currentQrcode = qrcode;
  let scannedNotified = false;

  log("Waiting for QR code scan (up to 8 minutes)...");

  while (Date.now() < deadline) {
    try {
      const status = await pollQRStatus(baseUrl, currentQrcode);

      switch (status.status) {
        case "wait":
          break;

        case "scaned":
          if (!scannedNotified) {
            scannedNotified = true;
            log("QR code scanned! Waiting for confirmation...");
            try {
              await mcp.notification({
                method: "notifications/claude/channel",
                params: {
                  content: "WeChat QR code has been scanned! Please confirm the login on your phone.",
                  meta: { type: "system", severity: "info" },
                },
              });
            } catch {}
          }
          break;

        case "expired":
          maxRefreshes--;
          if (maxRefreshes <= 0) {
            log("QR code expired too many times.");
            try {
              await mcp.notification({
                method: "notifications/claude/channel",
                params: {
                  content: "WeChat login failed: QR code expired too many times. Please call wechat_login again.",
                  meta: { type: "system", severity: "high" },
                },
              });
            } catch {}
            return;
          }
          log("QR code expired, refreshing...");
          const newQr = await fetchQRCode(baseUrl);
          currentQrcode = newQr.qrcode;
          scannedNotified = false;
          try {
            const qrterm = await import("qrcode-terminal");
            await new Promise((resolve) => {
              qrterm.default.generate(newQr.qrcode_img_content, { small: true }, (qr) => {
                console.error(qr);
                resolve();
              });
            });
          } catch {}
          try {
            await mcp.notification({
              method: "notifications/claude/channel",
              params: {
                content: `WeChat QR code expired and was refreshed. New QR URL: ${newQr.qrcode_img_content}`,
                meta: { type: "system", severity: "info", qr_url: newQr.qrcode_img_content },
              },
            });
          } catch {}
          break;

        case "confirmed": {
          if (!status.ilink_bot_id) {
            log("Login confirmed but no bot ID returned");
            return;
          }
          const creds = {
            token: status.bot_token,
            botId: status.ilink_bot_id,
            baseUrl: status.baseurl || baseUrl,
            userId: status.ilink_user_id,
            savedAt: new Date().toISOString(),
          };
          saveCredentials(creds);
          credentials = creds;

          // Auto-add the logging-in user to allowlist
          if (status.ilink_user_id && !allowlist.includes(status.ilink_user_id)) {
            allowlist.push(status.ilink_user_id);
            saveAllowlist(allowlist);
          }

          log("Login successful! Bot ID:", status.ilink_bot_id);

          // Notify Claude Code
          try {
            await mcp.notification({
              method: "notifications/claude/channel",
              params: {
                content: `WeChat login successful! Bot connected. You can now send messages from WeChat and I will receive them.`,
                meta: { type: "system", severity: "info" },
              },
            });
          } catch {}

          // Start message polling
          startPolling();
          return;
        }
      }
    } catch (err) {
      log("Login poll error:", err.message);
    }

    await new Promise((r) => setTimeout(r, 1000));
  }

  log("Login timed out.");
  try {
    await mcp.notification({
      method: "notifications/claude/channel",
      params: {
        content: "WeChat login timed out. Please call wechat_login again.",
        meta: { type: "system", severity: "high" },
      },
    });
  } catch {}
}

// ── WeChat Message API ──────────────────────────────────────────────────────

async function getUpdates(baseUrl, token, getUpdatesBuf) {
  try {
    const rawText = await apiFetch({
      baseUrl,
      endpoint: "ilink/bot/getupdates",
      body: JSON.stringify({
        get_updates_buf: getUpdatesBuf,
        base_info: { channel_version: "claude-code-1.0" },
      }),
      token,
      timeoutMs: LONG_POLL_TIMEOUT_MS,
      label: "getUpdates",
    });
    return JSON.parse(rawText);
  } catch (err) {
    if (err.name === "AbortError") {
      return { ret: 0, msgs: [], get_updates_buf: getUpdatesBuf };
    }
    throw err;
  }
}

function generateClientId() {
  return `cc-wx-${Date.now()}-${crypto.randomBytes(4).toString("hex")}`;
}

async function sendTextMessage(baseUrl, token, toUserId, text, contextToken) {
  if (!contextToken) {
    log("Warning: no contextToken for", toUserId, "- reply may not be associated with conversation");
  }
  const body = JSON.stringify({
    msg: {
      from_user_id: "",
      to_user_id: toUserId,
      client_id: generateClientId(),
      message_type: 2, // BOT
      message_state: 2, // FINISH
      item_list: [{ type: 1, text_item: { text } }],
      context_token: contextToken || undefined,
    },
    base_info: { channel_version: "claude-code-1.0" },
  });

  await apiFetch({
    baseUrl,
    endpoint: "ilink/bot/sendmessage",
    body,
    token,
    timeoutMs: API_TIMEOUT_MS,
    label: "sendMessage",
  });
}

// ── Extract text from message ───────────────────────────────────────────────

function extractText(msg) {
  const items = msg.item_list || [];
  const texts = [];
  for (const item of items) {
    if (item.type === 1 && item.text_item?.text) {
      texts.push(item.text_item.text);
    }
    if (item.type === 3 && item.voice_item?.text) {
      texts.push(`[Voice message] ${item.voice_item.text}`);
    }
  }
  return texts.join("\n") || "[non-text message]";
}

function hasMediaContent(msg) {
  const items = msg.item_list || [];
  return items.some((i) => [2, 3, 4, 5].includes(i.type));
}

// ── MCP Server ──────────────────────────────────────────────────────────────

const mcp = new Server(
  { name: "wechat", version: "1.0.0" },
  {
    capabilities: {
      experimental: { "claude/channel": {} },
      tools: {},
    },
    instructions: [
      "Messages from WeChat arrive as <channel source=\"wechat\" from=\"...\"> tags.",
      "Reply using the 'reply' tool, passing the 'from' attribute as the 'to' parameter.",
      "Use the 'wechat_login' tool if the channel is not connected.",
      "Use the 'wechat_allow' tool to add a WeChat user to the allowlist by their user ID.",
      "Keep replies concise - WeChat has a practical limit of ~4000 characters per message.",
      "If a reply is longer than 4000 chars, split it into multiple reply calls.",
    ].join(" "),
  }
);

// ── Tools ───────────────────────────────────────────────────────────────────

mcp.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    {
      name: "reply",
      description: "Send a reply message back to a WeChat user",
      inputSchema: {
        type: "object",
        properties: {
          to: {
            type: "string",
            description: "The WeChat user ID to reply to (from the 'from' attribute of the channel message)",
          },
          text: {
            type: "string",
            description: "The message text to send",
          },
        },
        required: ["to", "text"],
      },
    },
    {
      name: "wechat_login",
      description: "Login to WeChat by scanning a QR code. Run this to connect or reconnect to WeChat.",
      inputSchema: {
        type: "object",
        properties: {},
      },
    },
    {
      name: "wechat_allow",
      description: "Add a WeChat user ID to the allowlist so their messages are forwarded to Claude",
      inputSchema: {
        type: "object",
        properties: {
          user_id: {
            type: "string",
            description: "The WeChat user ID to allow",
          },
        },
        required: ["user_id"],
      },
    },
  ],
}));

mcp.setRequestHandler(CallToolRequestSchema, async (req) => {
  const { name, arguments: args } = req.params;

  switch (name) {
    case "reply": {
      const { to, text } = args;
      if (!credentials) {
        return {
          content: [{ type: "text", text: "Not logged in. Use wechat_login first." }],
          isError: true,
        };
      }
      const ct = contextTokens.get(to);
      // Split long messages
      const chunks = [];
      let remaining = text;
      while (remaining.length > 4000) {
        chunks.push(remaining.slice(0, 4000));
        remaining = remaining.slice(4000);
      }
      if (remaining) chunks.push(remaining);

      for (const chunk of chunks) {
        await sendTextMessage(
          credentials.baseUrl || DEFAULT_BASE_URL,
          credentials.token,
          to,
          chunk,
          ct
        );
      }
      log(`Replied to ${to}: ${text.slice(0, 80)}...`);
      return { content: [{ type: "text", text: `Sent ${chunks.length} message(s) to ${to}` }] };
    }

    case "wechat_login": {
      try {
        // Stop existing poll
        if (pollAbort) {
          pollAbort.abort();
          pollAbort = null;
        }
        const result = await startLogin(DEFAULT_BASE_URL);
        // startLogin returns immediately with the QR code.
        // Background polling handles the rest and sends notifications.
        const parts = [
          "Scan this QR code with your WeChat app to login:",
          "",
        ];
        if (result.qrAscii) {
          parts.push(result.qrAscii);
        }
        parts.push("");
        parts.push("If the QR code above doesn't render well, open this URL on your phone and scan from WeChat: " + result.qrUrl);
        parts.push("");
        parts.push("Waiting for scan... I'll be notified automatically when login succeeds.");
        return {
          content: [{ type: "text", text: parts.join("\n") }],
        };
      } catch (err) {
        return {
          content: [{ type: "text", text: `Login failed: ${err.message}` }],
          isError: true,
        };
      }
    }

    case "wechat_allow": {
      const { user_id } = args;
      if (!allowlist.includes(user_id)) {
        allowlist.push(user_id);
        saveAllowlist(allowlist);
      }
      return {
        content: [{ type: "text", text: `Added ${user_id} to allowlist. Current allowlist: ${allowlist.join(", ")}` }],
      };
    }

    default:
      throw new Error(`Unknown tool: ${name}`);
  }
});

// ── Message polling loop ────────────────────────────────────────────────────

async function startPolling() {
  if (!credentials) {
    log("No credentials found. Use wechat_login tool to connect.");
    return;
  }

  if (pollAbort) {
    pollAbort.abort();
  }
  pollAbort = new AbortController();
  const signal = pollAbort.signal;

  const baseUrl = credentials.baseUrl || DEFAULT_BASE_URL;
  const token = credentials.token;
  let getUpdatesBuf = loadSyncBuf();
  let consecutiveFailures = 0;

  log("Starting message polling...");

  while (!signal.aborted) {
    try {
      const resp = await getUpdates(baseUrl, token, getUpdatesBuf);

      if ((resp.ret !== undefined && resp.ret !== 0) || (resp.errcode !== undefined && resp.errcode !== 0)) {
        consecutiveFailures++;
        log(`getUpdates error: ret=${resp.ret} errcode=${resp.errcode} errmsg=${resp.errmsg || ""} (${consecutiveFailures}/${MAX_CONSECUTIVE_FAILURES})`);

        if (resp.errcode === -14) {
          log("Session expired. Please use wechat_login to reconnect.");
          await mcp.notification({
            method: "notifications/claude/channel",
            params: {
              content: "WeChat session expired. Please use the wechat_login tool to reconnect.",
              meta: { type: "system", severity: "high" },
            },
          });
          return;
        }

        if (consecutiveFailures >= MAX_CONSECUTIVE_FAILURES) {
          consecutiveFailures = 0;
          await sleep(BACKOFF_DELAY_MS, signal);
        } else {
          await sleep(RETRY_DELAY_MS, signal);
        }
        continue;
      }

      consecutiveFailures = 0;

      if (resp.get_updates_buf) {
        saveSyncBuf(resp.get_updates_buf);
        getUpdatesBuf = resp.get_updates_buf;
      }

      const msgs = resp.msgs || [];
      for (const msg of msgs) {
        // Only process user messages (type 1), not bot messages (type 2)
        if (msg.message_type !== 1) continue;

        const fromUserId = msg.from_user_id || "";

        // Allowlist check: if allowlist is non-empty, only forward allowed senders
        if (allowlist.length > 0 && !allowlist.includes(fromUserId)) {
          log(`Ignoring message from non-allowed sender: ${fromUserId}`);
          continue;
        }

        // Save context token for reply routing
        if (msg.context_token) {
          contextTokens.set(fromUserId, msg.context_token);
        }

        const text = extractText(msg);
        const hasMedia = hasMediaContent(msg);

        log(`Message from ${fromUserId}: ${text.slice(0, 100)}`);

        // Push to Claude Code as a channel notification
        await mcp.notification({
          method: "notifications/claude/channel",
          params: {
            content: text,
            meta: {
              from: fromUserId,
              message_id: String(msg.message_id || ""),
              has_media: hasMedia ? "true" : "false",
              timestamp: String(msg.create_time_ms || Date.now()),
            },
          },
        });
      }

      // Use server-suggested timeout if available
      if (resp.longpolling_timeout_ms > 0) {
        // Already handled by the next getUpdates call
      }
    } catch (err) {
      if (signal.aborted) return;

      consecutiveFailures++;
      log(`Poll error (${consecutiveFailures}/${MAX_CONSECUTIVE_FAILURES}):`, err.message);

      if (consecutiveFailures >= MAX_CONSECUTIVE_FAILURES) {
        consecutiveFailures = 0;
        await sleep(BACKOFF_DELAY_MS, signal);
      } else {
        await sleep(RETRY_DELAY_MS, signal);
      }
    }
  }
  log("Polling stopped.");
}

function sleep(ms, signal) {
  return new Promise((resolve, reject) => {
    const t = setTimeout(resolve, ms);
    signal?.addEventListener(
      "abort",
      () => {
        clearTimeout(t);
        resolve();
      },
      { once: true }
    );
  });
}

// ── Main ────────────────────────────────────────────────────────────────────

async function main() {
  log("WeChat Channel for Claude Code starting...");
  log("State directory:", STATE_DIR);

  await mcp.connect(new StdioServerTransport());
  log("MCP server connected via stdio.");

  // Auto-start polling if we have saved credentials
  if (credentials) {
    log("Found saved credentials, starting polling...");
    startPolling();
  } else {
    log("No saved credentials. Waiting for wechat_login tool call...");
    // Notify Claude that login is needed
    setTimeout(async () => {
      try {
        await mcp.notification({
          method: "notifications/claude/channel",
          params: {
            content: "WeChat channel is ready but not logged in. Use the wechat_login tool to connect your WeChat account by scanning a QR code.",
            meta: { type: "system", severity: "info" },
          },
        });
      } catch {}
    }, 1000);
  }
}

main().catch((err) => {
  log("Fatal error:", err);
  process.exit(1);
});
