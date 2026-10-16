// Decrypts an Oblimint backup object (OBKP) outside the panel: disaster
// recovery, inspection of a backup. stdin → stdout, passphrase from the
// environment (never on the command line):
//
//   OBLIMINT_BACKUP_PASSPHRASE='…' docker exec -i -e OBLIMINT_BACKUP_PASSPHRASE oblimint \
//     node dist/src/services/backups/decrypt.js < site-blog-code.tar.gz.obkp > site-blog-code.tar.gz
//
// The output is what was encrypted: .tar.gz (site code / data), .sql.gz
// (database dump), .pgdump (panel database, pg_restore), .json (manifest,
// panel configuration).
import { pipeline } from 'stream/promises';
import { decryptStream } from './crypto';

async function main(): Promise<void> {
  const passphrase = process.env.OBLIMINT_BACKUP_PASSPHRASE;
  if (!passphrase) {
    process.stderr.write('OBLIMINT_BACKUP_PASSPHRASE is not set\n');
    process.exit(2);
  }
  await pipeline(process.stdin, decryptStream(passphrase), process.stdout);
}

main().catch((err) => {
  process.stderr.write(`decrypt failed: ${err instanceof Error ? err.message : String(err)}\n`);
  process.exit(1);
});
