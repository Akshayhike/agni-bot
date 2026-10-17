/**
 * Minimal IMAP client over TLS. Supports LOGIN, SELECT, SEARCH, FETCH, LOGOUT.
 * Enough for the agent to search and read mail. No IDLE, no APPEND.
 */
import tls from "node:tls";

export interface ImapConfig {
  host: string;
  port: number;
  user: string;
  pass: string;
}

export interface ImapMessage {
  uid: number;
  flags: string[];
  subject: string;
  from: string;
  to: string;
  date: string;
  body: string;
  raw: string;
}

function parseHeaders(raw: string): { subject: string; from: string; to: string; date: string } {
  const lines = raw.split(/\r?\n/);
  let subject = "", from = "", to = "", date = "";
  for (const line of lines) {
    const lower = line.toLowerCase();
    if (lower.startsWith("subject:")) subject = line.slice(8).trim();
    else if (lower.startsWith("from:")) from = line.slice(5).trim();
    else if (lower.startsWith("to:")) to = line.slice(3).trim();
    else if (lower.startsWith("date:")) date = line.slice(5).trim();
    if (line === "") break; // end of headers
  }
  return { subject, from, to, date };
}

export class ImapClient {
  private socket: tls.TLSSocket | null = null;
  private buffer = "";
  private tagCounter = 0;

  private nextTag(): string {
    this.tagCounter++;
    return `A${this.tagCounter}`;
  }

  async connect(cfg: ImapConfig): Promise<void> {
    return new Promise((resolve, reject) => {
      const socket = tls.connect(cfg.port, cfg.host, { rejectUnauthorized: true }, () => {
        // Wait for greeting
      });
      this.socket = socket;
      let greeted = false;
      socket.on("data", (data) => {
        this.buffer += data.toString();
        if (!greeted && this.buffer.includes("\r\n")) {
          greeted = true;
          // Send login
          const tag = this.nextTag();
          socket.write(`${tag} LOGIN "${cfg.user}" "${cfg.pass}"\r\n`);
        }
      });
      // Handle login response
      const checkLogin = setInterval(() => {
        if (this.buffer.includes("OK") && this.buffer.includes("LOGIN")) {
          clearInterval(checkLogin);
          resolve();
        }
      }, 50);
      socket.on("error", (err) => { clearInterval(checkLogin); reject(err); });
      setTimeout(() => { clearInterval(checkLogin); if (!greeted) reject(new Error("IMAP greeting timeout")); }, 10000);
    });
  }

  private sendCommand(cmd: string): Promise<string> {
    return new Promise((resolve, reject) => {
      if (!this.socket) return reject(new Error("not connected"));
      const tag = this.nextTag();
      const fullCmd = `${tag} ${cmd}\r\n`;
      let response = "";
      const handler = (data: Buffer) => {
        response += data.toString();
        // Check if we got the tagged response
        if (response.includes(`${tag} OK`) || response.includes(`${tag} NO`) || response.includes(`${tag} BAD`)) {
          this.socket!.removeListener("data", handler);
          resolve(response);
        }
      };
      this.socket.on("data", handler);
      this.socket.write(fullCmd);
      setTimeout(() => {
        this.socket?.removeListener("data", handler);
        resolve(response);
      }, 15000);
    });
  }

  async select(mailbox: string): Promise<{ exists: number; recent: number }> {
    const resp = await this.sendCommand(`SELECT "${mailbox}"`);
    const existsMatch = resp.match(/\* (\d+) EXISTS/);
    const recentMatch = resp.match(/\* (\d+) RECENT/);
    return {
      exists: existsMatch ? parseInt(existsMatch[1]!) : 0,
      recent: recentMatch ? parseInt(recentMatch[1]!) : 0,
    };
  }

  async search(criteria: string): Promise<number[]> {
    const resp = await this.sendCommand(`SEARCH ${criteria}`);
    const match = resp.match(/\* SEARCH (.+)/);
    if (!match || !match[1]!.trim()) return [];
    return match[1]!.trim().split(/\s+/).map(Number).filter((n) => !isNaN(n));
  }

  async fetch(uid: number): Promise<ImapMessage | null> {
    const resp = await this.sendCommand(`FETCH ${uid} (FLAGS RFC822)`);
    // Parse the RFC822 content
    const rfcMatch = resp.match(/\{(\d+)\}\r?\n([\s\S]+?)\r?\nA\d+ (?:OK|NO|BAD)/);
    if (!rfcMatch) return null;
    const raw = rfcMatch[2]!;
    const { subject, from, to, date } = parseHeaders(raw);
    // Extract body (after blank line)
    const bodyStart = raw.indexOf("\r\n\r\n");
    const body = bodyStart >= 0 ? raw.slice(bodyStart + 4) : "";
    // Parse flags
    const flagsMatch = resp.match(/FLAGS \(([^)]*)\)/);
    const flags = flagsMatch ? flagsMatch[1]!.split(" ").filter(Boolean) : [];
    return { uid, flags, subject, from, to, date, body, raw };
  }

  async fetchAll(uids: number[]): Promise<ImapMessage[]> {
    const results: ImapMessage[] = [];
    for (const uid of uids) {
      const msg = await this.fetch(uid);
      if (msg) results.push(msg);
    }
    return results;
  }

  async close(): Promise<void> {
    if (this.socket) {
      this.socket.write("A99 LOGOUT\r\n");
      this.socket.destroy();
      this.socket = null;
    }
  }
}