// The builder SQL on an in-process Postgres (PGlite), behind the same Db interface the server
// uses with pg. One fresh database per call.
import { PGlite } from '@electric-sql/pglite'
import { type Db, migrate } from '../../server/lib/builder-db'

export interface TestDb extends Db {
  close(): Promise<void>
  /** When set, the next query throws this error (a database failure). */
  failNext?: Error
}

function wrap(q: { query: PGlite['query'] }, owner: TestDb): Db {
  const db: Db = {
    query: async <R>(sql: string, params: unknown[] = []) => {
      if (owner.failNext) {
        const err = owner.failNext
        owner.failNext = undefined
        throw err
      }
      const res = await q.query<R>(sql, params)
      return { rows: res.rows }
    },
    transaction: (fn) => fn(db)
  }
  return db
}

export async function testDb(migrated = true): Promise<TestDb> {
  const pg = new PGlite()
  const owner = {} as TestDb
  const plain = wrap(pg, owner)
  owner.query = plain.query
  owner.transaction = (fn) => pg.transaction((tx) => fn(wrap(tx, owner)))
  owner.close = () => pg.close()
  if (migrated) await migrate(owner)
  return owner
}
