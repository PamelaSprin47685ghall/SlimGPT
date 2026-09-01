import { cp, mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import process from 'node:process';
import { deflateRawSync, deflateSync } from 'node:zlib';

const target = process.argv[2];
if (!['chrome', 'firefox', 'orion'].includes(target)) {
  throw new Error('Usage: node scripts/build.mjs <chrome|firefox|orion>');
}

await ensureIcons();
await run(process.platform === 'win32' ? 'npx.cmd' : 'npx', ['vite', 'build', '--mode', target]);

const output = target === 'chrome' ? 'dist-extension' : `dist-${target}`;
const manifest = target === 'chrome' ? 'manifest.json' : `manifest.${target}.json`;
await mkdir(output, { recursive: true });
await cp(manifest, `${output}/manifest.json`);
for (const file of ['main-mitm.js', 'isolated-bridge.js']) {
  await cp(file, `${output}/${file}`);
}
const version = JSON.parse(await readFile(manifest, 'utf8')).version;
await writeReleaseArchive(output, target, version);

async function writeReleaseArchive(source, browserTarget, versionNumber) {
  const files = await collectFiles(source);
  const archiveExtension = browserTarget === 'firefox' ? 'xpi' : 'zip';
  await mkdir('release', { recursive: true });
  await writeFile(
    `release/slimgpt-${browserTarget}-${versionNumber}.${archiveExtension}`,
    makeZip(files),
  );
}

async function collectFiles(directory, prefix = '') {
  const output = [];
  const entries = await readdir(directory, { withFileTypes: true });
  entries.sort((left, right) => left.name.localeCompare(right.name));
  for (const entry of entries) {
    const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
    const path = `${directory}/${entry.name}`;
    if (entry.isDirectory()) output.push(...await collectFiles(path, relative));
    else if (entry.isFile()) output.push({ name: relative, data: await readFile(path) });
  }
  return output;
}

function makeZip(files) {
  const locals = [];
  const central = [];
  let offset = 0;

  for (const file of files) {
    const name = Buffer.from(file.name, 'utf8');
    const compressed = deflateRawSync(file.data, { level: 9 });
    const checksum = crc32(file.data);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0x0800, 6);
    local.writeUInt16LE(8, 8);
    local.writeUInt16LE(0, 10);
    local.writeUInt16LE(33, 12);
    local.writeUInt32LE(checksum, 14);
    local.writeUInt32LE(compressed.length, 18);
    local.writeUInt32LE(file.data.length, 22);
    local.writeUInt16LE(name.length, 26);
    locals.push(local, name, compressed);

    const entry = Buffer.alloc(46);
    entry.writeUInt32LE(0x02014b50, 0);
    entry.writeUInt16LE(20, 4);
    entry.writeUInt16LE(20, 6);
    entry.writeUInt16LE(0x0800, 8);
    entry.writeUInt16LE(8, 10);
    entry.writeUInt16LE(0, 12);
    entry.writeUInt16LE(33, 14);
    entry.writeUInt32LE(checksum, 16);
    entry.writeUInt32LE(compressed.length, 20);
    entry.writeUInt32LE(file.data.length, 24);
    entry.writeUInt16LE(name.length, 28);
    entry.writeUInt32LE(offset, 42);
    central.push(entry, name);
    offset += local.length + name.length + compressed.length;
  }

  const centralSize = central.reduce((total, part) => total + part.length, 0);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(files.length, 8);
  end.writeUInt16LE(files.length, 10);
  end.writeUInt32LE(centralSize, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, ...central, end]);
}

async function ensureIcons() {
  await mkdir('public/icons', { recursive: true });
  await Promise.all([
    writeFile('public/icons/slimgpt-48.png', makeIconPng(48)),
    writeFile('public/icons/slimgpt-128.png', makeIconPng(128)),
  ]);
}

function makeIconPng(size) {
  const stride = size * 4 + 1;
  const raw = Buffer.alloc(stride * size);
  const inside = (x, y, x0, y0, x1, y1) => x >= x0 && x <= x1 && y >= y0 && y <= y1;
  for (let y = 0; y < size; y += 1) {
    const row = y * stride;
    raw[row] = 0;
    for (let x = 0; x < size; x += 1) {
      const offset = row + 1 + x * 4;
      const nx = x / size;
      const ny = y / size;
      const radius = Math.hypot(nx - 0.5, ny - 0.5);
      const ring = radius > 0.32 && radius < 0.42;
      const sShape =
        inside(nx, ny, 0.32, 0.28, 0.68, 0.35) ||
        inside(nx, ny, 0.28, 0.28, 0.36, 0.51) ||
        inside(nx, ny, 0.32, 0.47, 0.68, 0.54) ||
        inside(nx, ny, 0.64, 0.50, 0.72, 0.73) ||
        inside(nx, ny, 0.32, 0.68, 0.68, 0.75);
      const rgb = sShape ? [245, 245, 240] : ring ? [61, 164, 132] : [17, 17, 17];
      raw[offset] = rgb[0];
      raw[offset + 1] = rgb[1];
      raw[offset + 2] = rgb[2];
      raw[offset + 3] = 255;
    }
  }

  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8;
  ihdr[9] = 6;
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    pngChunk('IHDR', ihdr),
    pngChunk('IDAT', deflateSync(raw, { level: 9 })),
    pngChunk('IEND', Buffer.alloc(0)),
  ]);
}

function pngChunk(type, data) {
  const name = Buffer.from(type, 'ascii');
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length, 0);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([name, data])), 0);
  return Buffer.concat([length, name, data, crc]);
}

function crc32(buffer) {
  let crc = 0xffffffff;
  for (const byte of buffer) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) {
      crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0);
    }
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function run(command, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: 'inherit', env: process.env });
    child.on('error', reject);
    child.on('exit', (code) => code === 0 ? resolve() : reject(new Error(`${command} exited ${code}`)));
  });
}
