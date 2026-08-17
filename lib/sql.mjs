/**
 * sql.mjs — tagged-template SQL client backed by node-postgres.
 *
 * Replaces `@neondatabase/serverless`, which spoke Neon's HTTP protocol and
 * therefore could not talk to the self-hosted Postgres this project now runs on.
 * The call shape is deliberately identical to the old `neon()` client so call
 * sites only changed their import:
 *
 *   const sql = sqlClient();                      // reads process.env.DATABASE_URL
 *   const rows = await sql`SELECT * FROM t WHERE id = ${id}`;   // tagged template
 *   const rows = await sql.query('SELECT 1');                   // plain string
 *
 * Values interpolated into the template are sent as bound parameters, never
 * concatenated into the SQL text, so this is not an injection vector.
 */
import pg from 'pg';

let pool;

/**
 * @param {string} [connectionString] defaults to process.env.DATABASE_URL
 * @returns {((s: TemplateStringsArray, ...v: any[]) => Promise<any[]>) & {query: Function, end: Function}}
 */
export function sqlClient(connectionString = process.env.DATABASE_URL) {
  if (!connectionString) {
    throw new Error(
      'DATABASE_URL is not set. The repo-root .env is authoritative — see .env.example.'
    );
  }
  if (!pool) {
    pool = new pg.Pool({
      connectionString,
      max: 4, // this box has a hard 3.8 GB ceiling; keep the pool small
      idleTimeoutMillis: 30_000,
      connectionTimeoutMillis: 15_000,
    });
  }
  const p = pool;

  const sql = async function (strings, ...values) {
    // Allow sql('SELECT 1') as well as sql`SELECT 1`
    if (typeof strings === 'string') {
      const res = await p.query(strings, values.length ? values[0] : undefined);
      return res.rows;
    }
    const text = strings.reduce((acc, cur, i) => acc + '$' + i + cur);
    const res = await p.query(text, values);
    return res.rows;
  };

  /** Execute plain SQL text (optionally parameterised). Returns rows. */
  sql.query = async (text, params) => (await p.query(text, params)).rows;

  /** Close the pool — call at the end of one-shot CLI scripts. */
  sql.end = async () => {
    if (pool) {
      await pool.end();
      pool = undefined;
    }
  };

  return sql;
}

export default sqlClient;
