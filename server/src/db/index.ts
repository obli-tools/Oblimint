import knex from 'knex';
import knexConfig from '../../knexfile';

// No connection is opened before the first query (pool min 0): importing this
// module is safe in setup mode, where no database exists yet.
export const db = knex(knexConfig);
