import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import { configFilePath, type PanelConfigFile } from '../../config';

/** Atomic 0600 write: temporary file in the same directory, fsync, rename. */
export async function writeFileAtomic0600(file: string, content: string): Promise<void> {
  await fs.promises.mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
  const tmp = path.join(path.dirname(file), `.${path.basename(file)}.${crypto.randomBytes(6).toString('hex')}.tmp`);
  const fh = await fs.promises.open(tmp, 'wx', 0o600);
  try {
    await fh.writeFile(content, 'utf-8');
    await fh.sync();
  } finally {
    await fh.close();
  }
  try {
    await fs.promises.chmod(tmp, 0o600);
    await fs.promises.rename(tmp, file);
  } catch (err) {
    await fs.promises.unlink(tmp).catch(() => {});
    throw err;
  }
}

/** Writes config/oblimint.json (the panel leaves setup mode at its next start). */
export async function writePanelConfig(cfg: PanelConfigFile): Promise<string> {
  await writeFileAtomic0600(configFilePath, `${JSON.stringify(cfg, null, 2)}\n`);
  return configFilePath;
}
