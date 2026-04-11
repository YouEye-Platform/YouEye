/**
 * SMTP Mailer
 *
 * Sends emails via raw SMTP using Node.js net/tls modules.
 * No external dependencies — uses the SMTP protocol directly.
 */

import * as net from 'net';
import * as tls from 'tls';

interface SmtpConfig {
  host: string;
  port: number;
  username: string;
  password: string;
  from: string;
  useTls: boolean;
  to: string;
}

/**
 * Send a test email through the configured SMTP server.
 * Uses STARTTLS on port 587 or implicit TLS on port 465.
 */
export async function sendTestEmail(config: SmtpConfig): Promise<void> {
  const { host, port, username, password, from, useTls, to } = config;
  const subject = 'YouEye SMTP Test';
  const body = 'This is a test email from your YouEye instance. If you received this, SMTP is configured correctly.';

  const message = [
    `From: ${from}`,
    `To: ${to}`,
    `Subject: ${subject}`,
    `Date: ${new Date().toUTCString()}`,
    `MIME-Version: 1.0`,
    `Content-Type: text/plain; charset=utf-8`,
    '',
    body,
  ].join('\r\n');

  return new Promise((resolve, reject) => {
    const timeout = 30000;
    let socket: net.Socket;
    let buffer = '';
    let step = 0;

    function handleResponse(data: string) {
      buffer += data;
      const lines = buffer.split('\r\n');
      buffer = lines.pop() || '';

      for (const line of lines) {
        if (line.length < 3) continue;
        const code = parseInt(line.substring(0, 3), 10);

        // Multi-line responses: wait for final line (no dash after code)
        if (line[3] === '-') continue;

        processCode(code, line);
      }
    }

    function processCode(code: number, line: string) {
      switch (step) {
        case 0: // Initial greeting
          if (code !== 220) return reject(new Error(`SMTP greeting failed: ${line}`));
          step = 1;
          send(`EHLO youeye.local`);
          break;
        case 1: // EHLO response
          if (code !== 250) return reject(new Error(`EHLO failed: ${line}`));
          if (useTls && port !== 465) {
            step = 2;
            send('STARTTLS');
          } else {
            step = 3;
            send(`AUTH LOGIN`);
          }
          break;
        case 2: // STARTTLS response
          if (code !== 220) return reject(new Error(`STARTTLS failed: ${line}`));
          // Upgrade to TLS
          socket.removeAllListeners('data');
          socket = tls.connect({ socket, host, rejectUnauthorized: false }, () => {
            step = 10; // Re-EHLO after TLS
            socket.on('data', (d: Buffer) => handleResponse(d.toString()));
            send('EHLO youeye.local');
          });
          break;
        case 10: // Re-EHLO after STARTTLS
          if (code !== 250) return reject(new Error(`EHLO after STARTTLS failed: ${line}`));
          step = 3;
          send('AUTH LOGIN');
          break;
        case 3: // AUTH LOGIN
          if (code !== 334) return reject(new Error(`AUTH LOGIN failed: ${line}`));
          step = 4;
          send(Buffer.from(username).toString('base64'));
          break;
        case 4: // Username sent
          if (code !== 334) return reject(new Error(`AUTH username failed: ${line}`));
          step = 5;
          send(Buffer.from(password).toString('base64'));
          break;
        case 5: // Password sent
          if (code !== 235) return reject(new Error(`Authentication failed: ${line}`));
          step = 6;
          send(`MAIL FROM:<${from}>`);
          break;
        case 6: // MAIL FROM
          if (code !== 250) return reject(new Error(`MAIL FROM failed: ${line}`));
          step = 7;
          send(`RCPT TO:<${to}>`);
          break;
        case 7: // RCPT TO
          if (code !== 250) return reject(new Error(`RCPT TO failed: ${line}`));
          step = 8;
          send('DATA');
          break;
        case 8: // DATA
          if (code !== 354) return reject(new Error(`DATA failed: ${line}`));
          step = 9;
          send(`${message}\r\n.`);
          break;
        case 9: // Message sent
          if (code !== 250) return reject(new Error(`Message delivery failed: ${line}`));
          send('QUIT');
          resolve();
          break;
      }
    }

    function send(data: string) {
      socket.write(data + '\r\n');
    }

    // Connect — implicit TLS on port 465, plain socket otherwise
    if (port === 465) {
      socket = tls.connect({ host, port, rejectUnauthorized: false }, () => {
        socket.on('data', (d: Buffer) => handleResponse(d.toString()));
      });
    } else {
      socket = net.createConnection({ host, port }, () => {
        socket.on('data', (d: Buffer) => handleResponse(d.toString()));
      });
    }

    socket.setTimeout(timeout, () => {
      socket.destroy();
      reject(new Error(`SMTP connection timed out after ${timeout / 1000}s`));
    });

    socket.on('error', (err) => {
      reject(new Error(`SMTP connection error: ${err.message}`));
    });
  });
}
