import fs from 'node:fs/promises';
import path from 'node:path';

export async function collectSystemMetrics(appDirectory, now = Date.now()) {
  const filesystem = await fs.statfs(appDirectory);
  const totalBytes = Number(filesystem.bsize) * Number(filesystem.blocks);
  const availableBytes = Number(filesystem.bsize) * Number(filesystem.bavail);
  const usedBytes = Math.max(0, totalBytes - availableBytes);
  const disk = {
    totalBytes,
    availableBytes,
    usedBytes,
    usedPercent: totalBytes ? Math.round((usedBytes / totalBytes) * 10_000) / 100 : 0,
  };

  const backupDirectory = path.join(appDirectory, 'backups');
  let latest = null;
  try {
    const entries = await fs.readdir(backupDirectory, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isFile() || !/^easyboost-.*\.dump$/u.test(entry.name)) continue;
      const stat = await fs.stat(path.join(backupDirectory, entry.name));
      if (!latest || stat.mtimeMs > latest.mtimeMs) {
        latest = { name: entry.name, sizeBytes: stat.size, mtimeMs: stat.mtimeMs };
      }
    }
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
  let restoreCheck = { status: 'missing', checkedAt: null, ageDays: null, fresh: false };
  try {
    const stored = JSON.parse(await fs.readFile(path.join(backupDirectory, 'restore-check-status.json'), 'utf8'));
    const checkedAtMs = Date.parse(stored.checkedAt);
    const ageDays = Number.isFinite(checkedAtMs)
      ? Math.round(((now - checkedAtMs) / 86_400_000) * 100) / 100
      : null;
    restoreCheck = {
      status: stored.status,
      checkedAt: stored.checkedAt || null,
      ageDays,
      fresh: stored.status === 'success' && ageDays !== null && ageDays <= 35,
      durationMs: Number.isFinite(stored.durationMs) ? stored.durationMs : null,
      backup: stored.backup || null,
    };
  } catch (error) {
    if (error.code !== 'ENOENT' && !(error instanceof SyntaxError)) throw error;
    if (error instanceof SyntaxError) restoreCheck.status = 'invalid';
  }
  return {
    disk,
    backup: latest ? {
      file: latest.name,
      sizeBytes: latest.sizeBytes,
      createdAt: new Date(latest.mtimeMs).toISOString(),
      ageHours: Math.round(((now - latest.mtimeMs) / 3_600_000) * 100) / 100,
      fresh: now - latest.mtimeMs <= 36 * 3_600_000,
    } : { file: null, sizeBytes: 0, createdAt: null, ageHours: null, fresh: false },
    restoreCheck,
  };
}
