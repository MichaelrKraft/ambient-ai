import os from 'os';
import path from 'path';

// All paths resolve relative to the user's home directory.
// Override AMBIENT_DB_PATH env var for testing or custom installs.
const AMBIENT_DIR =
  process.env.AMBIENT_DATA_DIR ?? path.join(os.homedir(), '.ambient');

export const PATHS = {
  dataDir: AMBIENT_DIR,
  db: process.env.AMBIENT_DB_PATH ?? path.join(AMBIENT_DIR, 'ambient.db'),
  pid: path.join(AMBIENT_DIR, 'daemon.pid'),
  log: path.join(AMBIENT_DIR, 'daemon.log'),
  config: path.join(AMBIENT_DIR, 'config.json'),
} as const;

// Use the IPv4 loopback explicitly (not "localhost"): screenpipe binds
// 127.0.0.1, and resolving "localhost" can prefer IPv6 (::1), which may land
// on a different server squatting on :3030 and make screenpipe look "down".
export const SCREENPIPE_BASE_URL =
  process.env.SCREENPIPE_URL ?? 'http://127.0.0.1:3030';

export const DAEMON_PORT = parseInt(process.env.AMBIENT_DAEMON_PORT ?? '3741', 10);
