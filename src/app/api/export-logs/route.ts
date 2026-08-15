import { NextResponse } from "next/server";
import { existsSync, readFileSync, readdirSync, statSync } from "fs";
import { join } from "path";
import os from "os";
import { scrubPiiBuffer } from "@/lib/log-scrub";

// Simple ZIP implementation for bundling log files (no external dependency)
function createZipBuffer(files: { name: string; data: Buffer }[]): Buffer {
  const parts: Buffer[] = [];
  const centralDirectory: Buffer[] = [];
  let offset = 0;

  for (const file of files) {
    // Local file header
    const nameBuffer = Buffer.from(file.name, "utf-8");
    const header = Buffer.alloc(30);
    header.writeUInt32LE(0x04034b50, 0); // signature
    header.writeUInt16LE(20, 4); // version needed
    header.writeUInt16LE(0, 6); // flags
    header.writeUInt16LE(0, 8); // compression (none)
    header.writeUInt16LE(0, 10); // mod time
    header.writeUInt16LE(0, 12); // mod date
    // CRC32
    const crc = crc32(file.data);
    header.writeUInt32LE(crc, 14);
    header.writeUInt32LE(file.data.length, 18); // compressed size
    header.writeUInt32LE(file.data.length, 22); // uncompressed size
    header.writeUInt16LE(nameBuffer.length, 26); // name length
    header.writeUInt16LE(0, 28); // extra length

    parts.push(header, nameBuffer, file.data);

    // Central directory entry
    const cdEntry = Buffer.alloc(46);
    cdEntry.writeUInt32LE(0x02014b50, 0);
    cdEntry.writeUInt16LE(20, 4); // version made by
    cdEntry.writeUInt16LE(20, 6); // version needed
    cdEntry.writeUInt16LE(0, 8); // flags
    cdEntry.writeUInt16LE(0, 10); // compression
    cdEntry.writeUInt16LE(0, 12); // mod time
    cdEntry.writeUInt16LE(0, 14); // mod date
    cdEntry.writeUInt32LE(crc, 16);
    cdEntry.writeUInt32LE(file.data.length, 20);
    cdEntry.writeUInt32LE(file.data.length, 24);
    cdEntry.writeUInt16LE(nameBuffer.length, 28);
    cdEntry.writeUInt16LE(0, 30); // extra length
    cdEntry.writeUInt16LE(0, 32); // comment length
    cdEntry.writeUInt16LE(0, 34); // disk number
    cdEntry.writeUInt16LE(0, 36); // internal attrs
    cdEntry.writeUInt32LE(0, 38); // external attrs
    cdEntry.writeUInt32LE(offset, 42); // offset of local header
    centralDirectory.push(cdEntry, nameBuffer);

    offset += 30 + nameBuffer.length + file.data.length;
  }

  const cdOffset = offset;
  let cdSize = 0;
  for (const buf of centralDirectory) cdSize += buf.length;

  // End of central directory
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(0, 4); // disk number
  eocd.writeUInt16LE(0, 6); // disk with CD
  eocd.writeUInt16LE(files.length, 8); // entries on disk
  eocd.writeUInt16LE(files.length, 10); // total entries
  eocd.writeUInt32LE(cdSize, 12);
  eocd.writeUInt32LE(cdOffset, 16);
  eocd.writeUInt16LE(0, 20); // comment length

  return Buffer.concat([...parts, ...centralDirectory, eocd]);
}

// CRC32 implementation
function crc32(data: Buffer): number {
  let crc = 0xffffffff;
  for (let i = 0; i < data.length; i++) {
    crc ^= data[i];
    for (let j = 0; j < 8; j++) {
      crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
    }
  }
  return (crc ^ 0xffffffff) >>> 0;
}

export async function POST() {
  const logDir = join(os.tmpdir(), "veksnap-logs");
  const files: { name: string; data: Buffer }[] = [];

  // Collect system info
  const sysInfo = [
    `Platform: ${os.platform()} ${os.arch()}`,
    `OS Release: ${os.release()}`,
    `Node: ${process.version}`,
    `CPUs: ${os.cpus().length}x ${os.cpus()[0]?.model || "unknown"}`,
    `Total RAM: ${Math.round(os.totalmem() / 1024 / 1024)}MB`,
    `Free RAM: ${Math.round(os.freemem() / 1024 / 1024)}MB`,
    `Uptime: ${Math.round(os.uptime() / 3600)}h`,
    `Timestamp: ${new Date().toISOString()}`,
  ].join("\n");
  files.push({ name: "system-info.txt", data: scrubPiiBuffer(Buffer.from(sysInfo, "utf-8")) });

  // Collect log files from veksnap-logs
  if (existsSync(logDir)) {
    try {
      const entries = readdirSync(logDir);
      for (const entry of entries) {
        const fullPath = join(logDir, entry);
        try {
          const stat = statSync(fullPath);
          if (stat.isFile() && stat.size < 10 * 1024 * 1024) { // max 10MB per file
            files.push({ name: `logs/${entry}`, data: scrubPiiBuffer(readFileSync(fullPath)) });
          }
        } catch { /* skip unreadable files */ }
      }
    } catch { /* dir read failed */ }
  }

  // Collect service logs from veksnap-app/logs if it exists
  const appLogDir = join(process.cwd(), "logs");
  if (existsSync(appLogDir)) {
    try {
      const entries = readdirSync(appLogDir);
      for (const entry of entries) {
        const fullPath = join(appLogDir, entry);
        try {
          const stat = statSync(fullPath);
          if (stat.isFile() && stat.size < 10 * 1024 * 1024) {
            files.push({ name: `service-logs/${entry}`, data: scrubPiiBuffer(readFileSync(fullPath)) });
          }
        } catch {}
      }
    } catch {}
  }

  if (files.length <= 1) {
    return NextResponse.json({ error: "No log files found" }, { status: 404 });
  }

  const zipBuffer = createZipBuffer(files);

  return new NextResponse(new Uint8Array(zipBuffer), {
    headers: {
      "Content-Type": "application/zip",
      "Content-Disposition": `attachment; filename="veksnap_logs_${Date.now()}.zip"`,
    },
  });
}
