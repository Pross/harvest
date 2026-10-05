import net from "node:net";
import tls from "node:tls";
import { constants } from "node:crypto";

/** Minimal FTP client for smoke checks, independent of Harvest and rclone. Passive mode only. */
export type FtpMode = "plain" | "explicit" | "implicit";
type Sock = net.Socket | tls.TLSSocket;

export class MiniFtp {
  private buf = "";
  private waiters: Array<() => void> = [];
  private constructor(private sock: Sock, private mode: FtpMode) { this.attach(sock); }

  private attach(s: Sock): void {
    s.setEncoding("utf8");
    s.on("data", (d: string) => { this.buf += d; this.waiters.splice(0).forEach((w) => w()); });
    s.setTimeout(15_000, () => s.destroy(new Error("ftp control timeout")));
  }

  static async connect(mode: FtpMode, port: number): Promise<MiniFtp> {
    const sock: Sock = await new Promise((resolve, reject) => {
      const s = mode === "implicit"
        ? tls.connect({ host: "127.0.0.1", port, rejectUnauthorized: false, maxVersion: "TLSv1.2", secureOptions: constants.SSL_OP_NO_TICKET }, () => resolve(s))
        : net.connect({ host: "127.0.0.1", port }, () => resolve(s));
      s.once("error", reject);
    });
    const c = new MiniFtp(sock, mode);
    await c.reply("220");
    if (mode === "explicit") await c.upgrade();
    else if (mode === "implicit") await c.protectData();
    return c;
  }

  /** Read one full (possibly multi-line) reply; check the code prefix. */
  async reply(expect: string): Promise<string> {
    for (let i = 0; i < 200; i++) {
      const m = /(?:^|\r\n)(\d{3}) [^\r\n]*\r\n$/.exec(this.buf);
      if (m) {
        const text = this.buf; this.buf = "";
        if (!text.startsWith(expect) && m[1] !== expect) throw new Error(`expected ${expect}, got ${text.trim()}`);
        return text;
      }
      await new Promise<void>((r) => { this.waiters.push(r); setTimeout(r, 100); });
    }
    throw new Error(`no ${expect} reply`);
  }

  async cmd(line: string, expect: string): Promise<string> {
    this.sock.write(line + "\r\n");
    return this.reply(expect);
  }

  private async upgrade(): Promise<void> {
    await this.cmd("AUTH TLS", "234");
    const plain = this.sock as net.Socket;
    plain.removeAllListeners("data");
    this.sock = tls.connect({ socket: plain, rejectUnauthorized: false, maxVersion: "TLSv1.2" });
    this.attach(this.sock);
    await new Promise<void>((r, j) => { this.sock.once("secureConnect", () => r()); this.sock.once("error", j); });
    await this.protectData();
  }

  /** vsftpd rejects clear data channels even on implicit TLS ("522 Data connections must be encrypted"). */
  private async protectData(): Promise<void> {
    await this.cmd("PBSZ 0", "200");
    await this.cmd("PROT P", "200");
  }

  async login(user: string, pass: string): Promise<void> {
    const r = await this.cmd(`USER ${user}`, "331").catch(() => "");
    if (r) await this.cmd(`PASS ${pass}`, "230");
  }

  private async pasvPort(): Promise<number> {
    const r = await this.cmd("PASV", "227");
    const m = /\((\d+),(\d+),(\d+),(\d+),(\d+),(\d+)\)/.exec(r);
    if (!m) throw new Error(`bad PASV reply ${r}`);
    return Number(m[5]) * 256 + Number(m[6]);
  }

  private dataSocket(port: number): Promise<Sock> {
    return new Promise((resolve, reject) => {
      const opts = { host: "127.0.0.1", port };
      const s: Sock = this.mode === "plain"
        ? net.connect(opts, () => resolve(s))
        : tls.connect({ ...opts, rejectUnauthorized: false, maxVersion: "TLSv1.2", secureOptions: constants.SSL_OP_NO_TICKET, session: (this.sock as tls.TLSSocket).getSession() }, () => resolve(s));
      s.once("error", reject);
    });
  }

  private async transfer(command: string, limit: number): Promise<Buffer> {
    const port = await this.pasvPort();
    this.sock.write(command + "\r\n");
    const data = await this.dataSocket(port);
    const chunks: Buffer[] = [];
    let got = 0;
    const done = new Promise<void>((resolve, reject) => {
      data.on("data", (d: Buffer) => { chunks.push(d); got += d.length; if (got >= limit) data.destroy(); });
      data.once("close", () => resolve());
      data.once("error", reject);
      data.setTimeout(15_000, () => data.destroy(new Error("data timeout")));
    });
    await this.reply("150");
    await done;
    this.sock.write("ABOR\r\n"); // harmless after completion; ends aborted transfers
    await new Promise((r) => setTimeout(r, 100));
    this.buf = "";
    return Buffer.concat(chunks).subarray(0, limit);
  }

  async list(dir: string): Promise<string[]> {
    const raw = (await this.transfer(`NLST ${dir}`, 1 << 20)).toString("utf8");
    return raw.split(/\r?\n/).filter(Boolean).map((l) => l.split("/").pop() ?? l);
  }

  /** Read `count` bytes starting at `offset` using REST + RETR (aborting after `count` bytes). */
  async readRange(file: string, offset: number, count: number): Promise<Buffer> {
    await this.cmd("TYPE I", "200");
    await this.cmd(`REST ${offset}`, "350");
    return this.transfer(`RETR ${file}`, count);
  }

  close(): void { this.sock.destroy(); }
}
