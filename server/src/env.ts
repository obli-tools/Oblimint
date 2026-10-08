import dotenv from 'dotenv';
import fs from 'fs';
import path from 'path';

// Development: the repository root .env (server/src → ../../.env). Compiled
// (server/dist/src) it would be server/.env: both are tried, the first found
// wins. In the container the environment comes from `docker run` only.
for (const candidate of [
  path.resolve(__dirname, '../../.env'),
  path.resolve(__dirname, '../../../.env'),
]) {
  if (fs.existsSync(candidate)) {
    dotenv.config({ path: candidate });
    break;
  }
}
