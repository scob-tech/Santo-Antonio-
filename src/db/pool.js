// Pool de conexões com o Postgres.
// Se não houver DATABASE_URL, exportamos "null" e o sistema roda em modo demo.
import pg from 'pg';
import { config, flags } from '../config.js';

let pool = null;

if (flags.temBanco) {
  pool = new pg.Pool({
    connectionString: config.databaseUrl,
    // Railway exige SSL; localmente normalmente não. Este ajuste cobre os dois.
    ssl: config.databaseUrl.includes('railway')
      ? { rejectUnauthorized: false }
      : false,
    max: 5,
  });

  pool.on('error', (err) => {
    console.error('[db] erro no pool:', err.message);
  });
}

// Helper de query que devolve [] se estiver em modo demo (sem banco).
export async function query(text, params) {
  if (!pool) return { rows: [], rowCount: 0 };
  return pool.query(text, params);
}

export function temPool() {
  return Boolean(pool);
}

export default pool;
