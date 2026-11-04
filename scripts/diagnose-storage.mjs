// Read-only storage report: no passwords, message bodies, phone numbers or cookies.
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { stat } from 'node:fs/promises';
import { DatabaseSync } from 'node:sqlite';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const dataDir = path.resolve(process.env.DATA_DIR || path.join(root, '.data'));
const volumePath = process.env.RAILWAY_VOLUME_MOUNT_PATH;
const volume = volumePath ? path.resolve(volumePath) : null;
const relative = volume ? path.relative(volume, dataDir) : null;
const report = {
  dataDir,
  railwayVolumeMountPath: volume,
  dataDirInsideReportedVolume: volume ? relative === '' || (!relative.startsWith('..' + path.sep) && relative !== '..' && !path.isAbsolute(relative)) : null,
};
let db;
try {
  const file = path.join(dataDir, 'blue-v.sqlite');
  report.databaseExists = (await stat(file)).isFile();
  db = new DatabaseSync(file, { readOnly: true });
  report.users = db.prepare('SELECT COUNT(*) AS count FROM users').get().count;
  report.numbers = db.prepare('SELECT COUNT(*) AS count FROM accounts').get().count;
  report.messages = db.prepare('SELECT COUNT(*) AS count FROM messages').get().count;
  report.numbersWithMessages = db.prepare('SELECT COUNT(DISTINCT account_id) AS count FROM messages').get().count;
  report.messageCountsByNumber = db.prepare('SELECT COUNT(*) AS count FROM messages GROUP BY account_id ORDER BY count DESC').all().map(row => row.count);
  const range = db.prepare('SELECT MIN(created_at) AS oldest, MAX(created_at) AS newest FROM messages').get();
  report.oldestMessageAt = range.oldest === null ? null : new Date(range.oldest).toISOString();
  report.newestMessageAt = range.newest === null ? null : new Date(range.newest).toISOString();
} catch (error) {
  report.errorCode = error.code || 'STORAGE_REPORT_FAILED';
  process.exitCode = 1;
} finally {
  db?.close();
}
console.log(JSON.stringify(report, null, 2));
