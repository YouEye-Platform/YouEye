import { createHash, randomBytes } from 'node:crypto';
import type { Duplex } from 'node:stream';

/**
 * Incus lifecycle events (`GET /1.0/events?type=lifecycle`), which Incus serves only over a WebSocket. This is the
 * small client side of RFC 6455 the Control Panel needs: one handshake, unmasked server frames (text, continuation,
 * ping, close) and masked pong and close replies.
 */

export interface LifecycleEvent { action: string; source: string; project?: string }

const WS_GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';
const MAX_MESSAGE = 1 << 20;

export interface WsFrame { fin: boolean; opcode: number; payload: Buffer }

/** Split complete frames off the front of `buffer`; returns them and the incomplete rest. */
export function parseFrames(buffer: Buffer): { frames: WsFrame[]; rest: Buffer } {
  const frames: WsFrame[] = [];
  let offset = 0;
  while (buffer.length - offset >= 2) {
    const first = buffer[offset];
    const second = buffer[offset + 1];
    let length = second & 0x7f;
    let header = 2;
    if (length === 126) {
      if (buffer.length - offset < 4) break;
      length = buffer.readUInt16BE(offset + 2);
      header = 4;
    } else if (length === 127) {
      if (buffer.length - offset < 10) break;
      const big = buffer.readBigUInt64BE(offset + 2);
      if (big > BigInt(MAX_MESSAGE)) throw new Error('Incus event frame is too large');
      length = Number(big);
      header = 10;
    }
    const masked = (second & 0x80) !== 0;
    const maskLength = masked ? 4 : 0;
    if (length > MAX_MESSAGE) throw new Error('Incus event frame is too large');
    if (buffer.length - offset < header + maskLength + length) break;
    const payload = Buffer.from(buffer.subarray(offset + header + maskLength, offset + header + maskLength + length));
    if (masked) {
      const mask = buffer.subarray(offset + header, offset + header + 4);
      for (let i = 0; i < payload.length; i++) payload[i] ^= mask[i % 4];
    }
    frames.push({ fin: (first & 0x80) !== 0, opcode: first & 0x0f, payload });
    offset += header + maskLength + length;
  }
  return { frames, rest: buffer.subarray(offset) };
}

/** A masked client frame (RFC 6455 requires clients to mask). Control payloads are short. */
export function clientFrame(opcode: number, payload: Buffer = Buffer.alloc(0)): Buffer {
  if (payload.length > 125) throw new Error('client frames here carry at most 125 bytes');
  const mask = randomBytes(4);
  const masked = Buffer.from(payload);
  for (let i = 0; i < masked.length; i++) masked[i] ^= mask[i % 4];
  return Buffer.concat([Buffer.from([0x80 | opcode, 0x80 | payload.length]), mask, masked]);
}

/** The lifecycle event in one Incus event message, or undefined for anything else. */
export function lifecycleEventOf(message: string): LifecycleEvent | undefined {
  try {
    const event = JSON.parse(message) as { type?: string; project?: string; metadata?: { action?: unknown; source?: unknown } };
    if (event.type !== 'lifecycle' || typeof event.metadata?.action !== 'string' || typeof event.metadata.source !== 'string') return undefined;
    return { action: event.metadata.action, source: event.metadata.source, project: event.project };
  } catch {
    return undefined;
  }
}

/** The instance name of an event source such as `/1.0/instances/app-sonarr?project=default`. */
export function instanceOfSource(source: string): string | undefined {
  const match = /^\/1\.0\/instances\/([^/?]+)(\?|$)/.exec(source);
  return match ? decodeURIComponent(match[1]) : undefined;
}

/**
 * Open the lifecycle event stream on a fresh connection (`open` returns it, calling its argument once connected).
 * `onOpen` runs once the handshake succeeded; `closed` settles when the stream ends, with an error when it never
 * opened.
 */
export function watchLifecycleEvents(
  open: (onReady: () => void) => Duplex,
  onEvent: (event: LifecycleEvent) => void,
  onOpen: () => void,
  idle: { pingAfterMs: number; answerWithinMs: number } = { pingAfterMs: 300_000, answerWithinMs: 60_000 },
): { close(): void; closed: Promise<void> } {
  const key = randomBytes(16).toString('base64');
  const expectedAccept = createHash('sha1').update(key + WS_GUID).digest('base64');
  let socket: Duplex;
  let opened = false;
  let buffer = Buffer.alloc(0);
  let message: Buffer[] = [];
  let messageLength = 0;
  // A stream quiet for `pingAfterMs` gets a ping; Incus answers pings, so no data within `answerWithinMs` means the
  // connection is gone without a close (a half-open socket). Then the stream fails and the watch reconnects.
  let idleTimer: ReturnType<typeof setTimeout> | undefined;
  let answerTimer: ReturnType<typeof setTimeout> | undefined;
  const stopTimers = () => {
    clearTimeout(idleTimer);
    clearTimeout(answerTimer);
  };
  const closed = new Promise<void>((resolve, reject) => {
    const armIdle = () => {
      stopTimers();
      idleTimer = setTimeout(() => {
        socket.write(clientFrame(0x9));
        answerTimer = setTimeout(() => fail(new Error('Incus event stream stopped answering')), idle.answerWithinMs);
        answerTimer.unref?.();
      }, idle.pingAfterMs);
      idleTimer.unref?.();
    };
    const fail = (error: Error) => {
      stopTimers();
      socket.destroy();
      if (opened) resolve(); else reject(error);
    };
    socket = open(() => {
      socket.write([
        'GET /1.0/events?type=lifecycle HTTP/1.1',
        'Host: localhost',
        'Upgrade: websocket',
        'Connection: Upgrade',
        `Sec-WebSocket-Key: ${key}`,
        'Sec-WebSocket-Version: 13',
        '',
        '',
      ].join('\r\n'));
    });
    const keepAlive = (socket as Duplex & { setKeepAlive?: (on: boolean, delay: number) => void }).setKeepAlive;
    keepAlive?.call(socket, true, 30_000);
    socket.on('data', (chunk: Buffer) => {
      buffer = Buffer.concat([buffer, chunk]);
      if (opened) armIdle();
      try {
        if (!opened) {
          const end = buffer.indexOf('\r\n\r\n');
          if (end < 0) {
            if (buffer.length > 16_384) throw new Error('Incus event handshake is too long');
            return;
          }
          const lines = buffer.subarray(0, end).toString('latin1').split('\r\n');
          const status = Number(lines[0]?.split(' ')[1]);
          const accept = lines.find((line) => /^sec-websocket-accept:/i.test(line))?.split(':')[1]?.trim();
          if (status !== 101 || accept !== expectedAccept) throw new Error(`Incus events answered ${lines[0] ?? 'nothing'}`);
          opened = true;
          buffer = buffer.subarray(end + 4);
          armIdle();
          onOpen();
        }
        const { frames, rest } = parseFrames(buffer);
        buffer = Buffer.from(rest);
        for (const frame of frames) {
          if (frame.opcode === 0x9) {
            socket.write(clientFrame(0xa, frame.payload));
          } else if (frame.opcode === 0x8) {
            socket.write(clientFrame(0x8));
            socket.end();
          } else if (frame.opcode === 0x1 || frame.opcode === 0x0) {
            message.push(frame.payload);
            messageLength += frame.payload.length;
            if (messageLength > MAX_MESSAGE) throw new Error('Incus event message is too large');
            if (frame.fin) {
              const event = lifecycleEventOf(Buffer.concat(message).toString('utf8'));
              message = [];
              messageLength = 0;
              if (event) onEvent(event);
            }
          }
        }
      } catch (error) {
        fail(error instanceof Error ? error : new Error(String(error)));
      }
    });
    socket.on('error', (error: Error) => fail(error));
    socket.on('close', () => {
      stopTimers();
      if (opened) resolve(); else reject(new Error('Incus closed the event stream before it opened'));
    });
  });
  // `open` may throw before it returns a socket (then `closed` rejects): close() has nothing to destroy (YE-211).
  return { close: () => { stopTimers(); (socket as Duplex | undefined)?.destroy(); }, closed };
}
