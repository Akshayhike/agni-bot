/**
 * Minimal SMTP client over TLS (port 465). Sends one email.
 */
import tls from "node:tls";

export interface SmtpConfig {
  host: string;
  port: number;
  user: string;
  pass: string;
}

export async function sendEmail(
  cfg: SmtpConfig,
  from: string,
  to: string[],
  subject: string,
  body: string,
): Promise<{ ok: boolean; error?: string }> {
  return new Promise((resolve) => {
    const socket = tls.connect(cfg.port, cfg.host, { rejectUnauthorized: true });
    let buffer = "";
    let state = "greeting"; // greeting -> ehlo -> auth -> mailfrom -> rcpt -> data -> content -> quit

    const send = (line: string) => socket.write(line + "\r\n");

    socket.on("data", (data) => {
      buffer += data.toString();
      // Wait for complete response (last line starts with code + space, not code + -)
      const lines = buffer.split("\r\n").filter(Boolean);
      const lastLine = lines[lines.length - 1] || "";
      if (/^\d{3}-/.test(lastLine)) return; // multi-line, wait for more

      const code = parseInt(lastLine.slice(0, 3), 10);
      if (isNaN(code)) return;

      buffer = ""; // reset for next command

      if (code >= 400) {
        socket.destroy();
        resolve({ ok: false, error: `SMTP ${code}: ${lastLine}` });
        return;
      }

      switch (state) {
        case "greeting":
          state = "ehlo";
          send("EHLO agni");
          break;
        case "ehlo":
          state = "auth";
          send("AUTH LOGIN");
          break;
        case "auth":
          state = "user";
          send(Buffer.from(cfg.user).toString("base64"));
          break;
        case "user":
          state = "pass";
          send(Buffer.from(cfg.pass).toString("base64"));
          break;
        case "pass":
          state = "mailfrom";
          send(`MAIL FROM:<${from}>`);
          break;
        case "mailfrom":
          state = "rcpt";
          send(`RCPT TO:<${to[0]}>`);
          break;
        case "rcpt": {
          // If more recipients, send next RCPT TO
          const sent = to.filter((_, i) => i < to.indexOf(to[to.length - 1]!) + 1).length;
          // Simple: handle one recipient for now, or advance
          state = "data";
          if (to.length > 1) {
            // Send remaining RCPT TO
            for (let i = 1; i < to.length; i++) {
              send(`RCPT TO:<${to[i]}>`);
            }
          }
          send("DATA");
          break;
        }
        case "data":
          state = "content";
          // Send headers + body + terminator
          const msg = [
            `From: ${from}`,
            `To: ${to.join(", ")}`,
            `Subject: ${subject}`,
            `Content-Type: text/plain; charset=utf-8`,
            `MIME-Version: 1.0`,
            ``,
            body,
            `.`,
          ].join("\r\n");
          socket.write(msg + "\r\n");
          break;
        case "content":
          state = "quit";
          send("QUIT");
          break;
        case "quit":
          socket.destroy();
          resolve({ ok: true });
          break;
      }
    });

    socket.on("error", (err) => {
      socket.destroy();
      resolve({ ok: false, error: err.message });
    });

    setTimeout(() => {
      socket.destroy();
      resolve({ ok: false, error: "SMTP timeout" });
    }, 30000);
  });
}