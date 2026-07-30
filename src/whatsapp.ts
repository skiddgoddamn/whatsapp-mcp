import {
  makeWASocket,
  useMultiFileAuthState,
  fetchLatestBaileysVersion,
  makeCacheableSignalKeyStore,
  DisconnectReason,
  type WAMessage,
  type proto,
  isJidGroup,
  jidNormalizedUser,
} from "@whiskeysockets/baileys";
import P from "pino";
import path from "node:path";
import qrcodeTerminal from "qrcode-terminal";
import { showQr, qrConnected } from "./qr-server.ts";

import {
  initializeDatabase,
  storeMessage,
  storeChat,
  storeContact,
  type Message as DbMessage,
} from "./database.ts";

const AUTH_DIR = path.join(import.meta.dirname, "..", "auth_info");

// Kept at module scope so it survives the recursive reconnect below.
let reconnectAttempts = 0;

export type WhatsAppSocket = ReturnType<typeof makeWASocket>;

// The reconnect path below builds a BRAND NEW socket. Callers that captured the
// first one would keep writing into a dead websocket forever ("Connection
// Closed" on every send while reads still work, because reads come from SQLite).
// So the live socket lives here and consumers must go through getCurrentSocket().
let currentSocket: WhatsAppSocket | null = null;
let connectionOpen = false;
let openWaiters: Array<() => void> = [];

export function getCurrentSocket(): WhatsAppSocket | null {
  return currentSocket;
}

export function isConnectionOpen(): boolean {
  return connectionOpen;
}

function markConnectionOpen(): void {
  connectionOpen = true;
  const waiters = openWaiters;
  openWaiters = [];
  for (const resolve of waiters) resolve();
}

/**
 * A freshly spawned process answers MCP calls within milliseconds, long before
 * the websocket finishes opening — `sock.user` is already populated from cached
 * creds, so a naive guard passes and the send dies with "Connection Closed".
 * Wait for the socket to actually be open instead of failing the race.
 */
export function waitForConnectionOpen(timeoutMs = 20_000): Promise<boolean> {
  if (connectionOpen) return Promise.resolve(true);
  return new Promise((resolve) => {
    let settled = false;
    const done = (ok: boolean) => {
      if (settled) return;
      settled = true;
      resolve(ok);
    };
    const timer = setTimeout(() => done(false), timeoutMs);
    openWaiters.push(() => {
      clearTimeout(timer);
      done(true);
    });
  });
}

// WAMessageStatus numeric values (Baileys proto enum).
const STATUS_ERROR = 0;
const STATUS_SERVER_ACK = 2;

// Baileys resolves sendMessage as soon as the frame is relayed; the server's
// verdict arrives later as a messages.update. Without this the caller is told
// "sent successfully" even when WhatsApp rejected the message (ack error 463),
// which is indistinguishable from real delivery.
const pendingAcks = new Map<string, (status: number) => void>();

function resolveAck(msgId: string, status: number): void {
  const resolve = pendingAcks.get(msgId);
  if (resolve) {
    pendingAcks.delete(msgId);
    resolve(status);
  }
}

export type SendOutcome = {
  ok: boolean;
  msgId?: string;
  /** "delivered" | "rejected" | "unconfirmed" | "no-connection" | "error" */
  state: string;
  detail?: string;
};

function parseMessageForDb(msg: WAMessage): DbMessage | null {
  if (!msg.message || !msg.key || !msg.key.remoteJid) {
    return null;
  }

  let content: string | null = null;
  const messageType = Object.keys(msg.message)[0];

  if (msg.message.conversation) {
    content = msg.message.conversation;
  } else if (msg.message.extendedTextMessage?.text) {
    content = msg.message.extendedTextMessage.text;
  } else if (msg.message.imageMessage?.caption) {
    content = `[Image] ${msg.message.imageMessage.caption}`;
  } else if (msg.message.videoMessage?.caption) {
    content = `[Video] ${msg.message.videoMessage.caption}`;
  } else if (msg.message.documentMessage?.caption) {
    content = `[Document] ${
      msg.message.documentMessage.caption ||
      msg.message.documentMessage.fileName ||
      ""
    }`;
  } else if (msg.message.audioMessage) {
    content = `[Audio]`;
  } else if (msg.message.stickerMessage) {
    content = `[Sticker]`;
  } else if (msg.message.locationMessage?.address) {
    content = `[Location] ${msg.message.locationMessage.address}`;
  } else if (msg.message.contactMessage?.displayName) {
    content = `[Contact] ${msg.message.contactMessage.displayName}`;
  } else if (msg.message.pollCreationMessage?.name) {
    content = `[Poll] ${msg.message.pollCreationMessage.name}`;
  }

  if (!content) {
    return null;
  }

  // Use WhatsApp's original message timestamp (seconds since epoch)
  let timestampSeconds: number;

  if (msg.messageTimestamp != null) {
    // Handles number, bigint, and Long-like objects
    timestampSeconds = Number(msg.messageTimestamp);
  } else {
    // Fallback only if WA didn't give us a timestamp at all
    timestampSeconds = Date.now() / 1000;
  }

  const timestamp = new Date(timestampSeconds * 1000);

  let senderJid: string | null | undefined = msg.key.participant;
  if (!msg.key.fromMe && !senderJid && !isJidGroup(msg.key.remoteJid)) {
    senderJid = msg.key.remoteJid;
  }
  if (msg.key.fromMe && !isJidGroup(msg.key.remoteJid)) {
    senderJid = null;
  }

  return {
    id: msg.key.id!,
    chat_jid: msg.key.remoteJid,
    sender: senderJid ? jidNormalizedUser(senderJid) : null,
    content: content,
    timestamp: timestamp,
    is_from_me: msg.key.fromMe ?? false,
  };
}

export async function startWhatsAppConnection(
  logger: P.Logger
): Promise<WhatsAppSocket> {
  initializeDatabase();

  const { state, saveCreds } = await useMultiFileAuthState(AUTH_DIR);
  const { version, isLatest } = await fetchLatestBaileysVersion();
  logger.info(`Using WA v${version.join(".")}, isLatest: ${isLatest}`);

  const sock = makeWASocket({
    version,
    logger,
    auth: {
      creds: state.creds,
      keys: makeCacheableSignalKeyStore(state.keys, logger),
    },
    generateHighQualityLinkPreview: true,
    shouldIgnoreJid: (jid) => isJidGroup(jid),
  });

  // Publish the live socket immediately so reconnects propagate to consumers.
  currentSocket = sock;
  connectionOpen = false;

  sock.ev.process(async (events) => {
    if (events["connection.update"]) {
      const update = events["connection.update"];
      const { connection, lastDisconnect, qr } = update;

      if (qr) {
        // Live QR on a local page that auto-refreshes on each ~20s rotation and
        // shows "connected" once paired — no external service, no static image.
        // ASCII to STDERR too (stdout is the MCP JSON-RPC channel) for headless.
        showQr(qr, logger);
        qrcodeTerminal.generate(qr, { small: true }, (ascii: string) =>
          process.stderr.write("\n" + ascii + "\n")
        );
      }

      if (connection === "close") {
        connectionOpen = false;
        const statusCode = (lastDisconnect?.error as any)?.output?.statusCode;
        logger.warn(
          `Connection closed. Reason: ${
            DisconnectReason[statusCode as number] || "Unknown"
          }`,
          lastDisconnect?.error
        );
        if (statusCode === DisconnectReason.loggedOut) {
          logger.error(
            "Connection closed: Logged Out. Please delete auth_info and restart."
          );
          process.exit(1);
        } else {
          // Exponential backoff. The original reconnected with ZERO delay, so a
          // `connectionReplaced` (two instances) or any repeated failure became a
          // tight registration storm — exactly what makes WhatsApp refuse device
          // linking ("linking temporarily unavailable"). Back off instead.
          const delay = Math.min(30_000, 2_000 * 2 ** reconnectAttempts);
          reconnectAttempts++;
          logger.info(
            `Reconnecting in ${Math.round(delay / 1000)}s (attempt ${reconnectAttempts})...`
          );
          setTimeout(() => startWhatsAppConnection(logger), delay);
        }
      } else if (connection === "open") {
        reconnectAttempts = 0;
        markConnectionOpen();
        logger.info(`Connection opened. WA user: ${sock.user?.name}`);
        qrConnected(logger);
      }
    }

    if (events["creds.update"]) {
      await saveCreds();
      logger.info("Credentials saved.");
    }

    if (events["messaging-history.set"]) {
      const { chats, contacts, messages, isLatest, progress, syncType } =
        events["messaging-history.set"];
      if (contacts.length > 0) {
        logger.info(`Storing ${contacts.length} contacts from history sync.`);
        contacts.forEach((c) =>
          storeContact({
            jid: c.id,
            name: c.name ?? null,
            notify: c.notify ?? null,
            phoneNumber: (c as any).phoneNumber ?? null,
          })
        );
        logger.info(`Stored ${contacts.length} contacts from history sync.`);
      }

      logger.info(`Storing ${chats.length} chats from history sync.`);
      chats.forEach((chat) =>
        storeChat({
          jid: chat.id,
          name: chat.name,
          last_message_time: chat.conversationTimestamp
            ? new Date(Number(chat.conversationTimestamp) * 1000)
            : undefined,
        })
      );

      let storedCount = 0;
      messages.forEach((msg) => {
        const parsed = parseMessageForDb(msg);
        if (parsed) {
          storeMessage(parsed);
          storedCount++;
        }
      });
      logger.info(`Stored ${storedCount} messages from history sync.`);
    }

    if (events["messages.upsert"]) {
      const { messages, type } = events["messages.upsert"];
      logger.info(
        { type, count: messages.length },
        "Received messages.upsert event"
      );

      if (type === "notify" || type === "append") {
        for (const msg of messages) {
          const parsed = parseMessageForDb(msg);
          if (parsed) {
            logger.info(
              {
                msgId: parsed.id,
                chatId: parsed.chat_jid,
                fromMe: parsed.is_from_me,
                sender: parsed.sender,
              },
              `Storing message: ${parsed.content.substring(0, 50)}...`
            );
            storeMessage(parsed);
          } else {
            logger.warn(
              { msgId: msg.key?.id, chatId: msg.key?.remoteJid },
              "Skipped storing message (parsing failed or unsupported type)"
            );
          }
        }
      }
    }

    if (events["messages.update"]) {
      for (const { key, update } of events["messages.update"]) {
        const status = (update as any)?.status;
        if (key?.id != null && typeof status === "number") {
          if (status === STATUS_ERROR) {
            logger.warn(
              { msgId: key.id, chatId: key.remoteJid },
              "Server REJECTED the message (status ERROR) — it was NOT delivered"
            );
          }
          resolveAck(key.id, status);
        }
      }
    }

    if (events["chats.update"]) {
      logger.info(
        { count: events["chats.update"].length },
        "Received chats.update event"
      );
      for (const chatUpdate of events["chats.update"]) {
        storeChat({
          jid: chatUpdate.id!,
          name: chatUpdate.name,
          last_message_time: chatUpdate.conversationTimestamp
            ? new Date(Number(chatUpdate.conversationTimestamp) * 1000)
            : undefined,
        });
      }
    }
  });

  return sock;
}

/**
 * Sends a message and reports what actually happened.
 *
 * Two things this deliberately does NOT do:
 *  - trust a caller-held socket (it may be a dead one from before a reconnect);
 *  - call a relayed frame a delivered message (WhatsApp can still reject it).
 */
export async function sendWhatsAppMessage(
  logger: P.Logger,
  recipientJid: string,
  text: string,
  opts: { connectTimeoutMs?: number; ackTimeoutMs?: number } = {}
): Promise<SendOutcome> {
  const { connectTimeoutMs = 20_000, ackTimeoutMs = 15_000 } = opts;

  if (!recipientJid) {
    logger.error("Cannot send message: Recipient JID is missing.");
    return { ok: false, state: "error", detail: "Recipient JID is missing." };
  }
  if (!text) {
    logger.error("Cannot send message: Message text is empty.");
    return { ok: false, state: "error", detail: "Message text is empty." };
  }

  if (!connectionOpen) {
    logger.info("Socket not open yet — waiting before sending.");
    const opened = await waitForConnectionOpen(connectTimeoutMs);
    if (!opened) {
      logger.error("Cannot send message: WhatsApp connection is not open.");
      return {
        ok: false,
        state: "no-connection",
        detail: `WhatsApp connection was not open after ${Math.round(connectTimeoutMs / 1000)}s.`,
      };
    }
  }

  const sock = currentSocket;
  if (!sock) {
    logger.error("Cannot send message: no active WhatsApp socket.");
    return { ok: false, state: "no-connection", detail: "No active socket." };
  }

  let msgId: string | undefined;
  try {
    logger.info(
      `Sending message to ${recipientJid}: ${text.substring(0, 50)}...`
    );
    const normalizedJid = jidNormalizedUser(recipientJid);
    const result = await sock.sendMessage(normalizedJid, { text: text });
    msgId = result?.key?.id ?? undefined;
    if (!msgId) {
      return { ok: false, state: "error", detail: "No message id returned." };
    }
  } catch (error: any) {
    logger.error({ err: error, recipientJid }, "Failed to send message");
    return { ok: false, state: "error", detail: error?.message ?? String(error) };
  }

  // Frame relayed. Now wait for the server's verdict.
  const status = await new Promise<number | null>((resolve) => {
    const timer = setTimeout(() => {
      pendingAcks.delete(msgId!);
      resolve(null);
    }, ackTimeoutMs);
    pendingAcks.set(msgId!, (s) => {
      clearTimeout(timer);
      resolve(s);
    });
  });

  if (status === STATUS_ERROR) {
    logger.error(
      { msgId, recipientJid },
      "Message REJECTED by WhatsApp (ack error) — not delivered"
    );
    return {
      ok: false,
      msgId,
      state: "rejected",
      detail:
        "WhatsApp rejected the message (ack error). Common causes: the number is not on WhatsApp, or the account is rate-limited/restricted for messaging strangers.",
    };
  }

  if (status !== null && status >= STATUS_SERVER_ACK) {
    logger.info({ msgId, status }, "Message delivered (server acknowledged)");
    return { ok: true, msgId, state: "delivered" };
  }

  logger.warn(
    { msgId, status },
    "Message relayed but not acknowledged in time — delivery unconfirmed"
  );
  return {
    ok: true,
    msgId,
    state: "unconfirmed",
    detail: `Relayed but no server acknowledgement within ${Math.round(ackTimeoutMs / 1000)}s — delivery is not confirmed.`,
  };
}
