import path from 'path';
import type { Knex } from 'knex';
import { config as appConfig, DATABASE_URL_MISSING } from './src/config';

const isCompiled = __filename.endsWith('.js');

// The connection is resolved at each new connection (function form): in setup
// mode there is no database at first, and the setup wizard sets
// appConfig.databaseUrl once it has deployed PostgreSQL (services/setup).
function connection(): { connectionString: string } {
  if (!appConfig.databaseUrl) throw new Error(DATABASE_URL_MISSING);
  return { connectionString: appConfig.databaseUrl };
}

const config: Knex.Config = {
  client: 'pg',
  connection,
  searchPath: ['public'],
  migrations: {
    // Absolute: works whatever the working directory (dev, dist, harness).
    directory: path.join(__dirname, 'src/db/migrations'),
    extension: isCompiled ? 'js' : 'ts',
    loadExtensions: isCompiled ? ['.js'] : ['.ts'],
    schemaName: 'public',
    // An image rolled back to an older version must still boot (see Obliance).
    disableMigrationsListValidation: true,
  },
  pool: {
    // min 0: nothing is opened before the first query (setup mode, and the
    // waitForDatabase retry loop at boot).
    min: 0,
    max: 20,
  },
  acquireConnectionTimeout: 20_000,
};

export default config;
