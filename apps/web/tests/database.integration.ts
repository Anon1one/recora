import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { databaseConfigured, testDatabase } from "./database-fixture";

test(
  "Neon schema enforces deduplication, atomic jobs, one-use challenges and rollback recovery",
  { skip: !databaseConfigured },
  async () => {
    const fixture = await testDatabase();
    const { pool } = fixture;
    try {
      const c = await pool.connect(),
        prefix = randomUUID();
      try {
        await c.query("BEGIN");
        await c.query(
          "INSERT INTO chain_transactions(id,cluster,signature) VALUES($1,$2,$3) ON CONFLICT DO NOTHING",
          [prefix, prefix, prefix],
        );
        await c.query(
          "INSERT INTO chain_transactions(id,cluster,signature) VALUES($1,$2,$3) ON CONFLICT DO NOTHING",
          [prefix, prefix, prefix],
        );
        assert.equal(
          (
            await c.query(
              "SELECT count(*)::int AS n FROM chain_transactions WHERE id=$1",
              [prefix],
            )
          ).rows[0].n,
          1,
        );
        const id = `${prefix}:event`;
        await c.query(
          "INSERT INTO chain_events(id,cluster,signature,slot,tx_index,log_index,type,subject,merchant,occurred_at,data) VALUES($1,$2,$2,1,0,0,'Subscribed',$2,$2,now(),'{}')",
          [id, prefix],
        );
        await c.query(
          "INSERT INTO webhook_endpoints(id,cluster,merchant,url,secret,filters) VALUES($1,$1,$1,'https://example.com','encrypted','[]')",
          [prefix],
        );
        await c.query(
          "INSERT INTO webhook_deliveries(id,endpoint,event,payload) VALUES($1,$2,$3,'{}') ON CONFLICT DO NOTHING",
          [`${prefix}:delivery`, prefix, id],
        );
        await c.query(
          "INSERT INTO webhook_deliveries(id,endpoint,event,payload) VALUES($1,$2,$3,'{}') ON CONFLICT DO NOTHING",
          [`${prefix}:duplicate`, prefix, id],
        );
        assert.equal(
          (
            await c.query(
              "SELECT count(*)::int AS n FROM webhook_deliveries WHERE endpoint=$1",
              [prefix],
            )
          ).rows[0].n,
          1,
        );
        await c.query("SAVEPOINT crash");
        await c.query(
          "UPDATE webhook_deliveries SET status='delivered' WHERE endpoint=$1",
          [prefix],
        );
        await c.query("ROLLBACK TO SAVEPOINT crash");
        assert.equal(
          (
            await c.query(
              "SELECT status FROM webhook_deliveries WHERE endpoint=$1",
              [prefix],
            )
          ).rows[0].status,
          "pending",
        );
        await c.query(
          "INSERT INTO auth_challenges(id,wallet,message,expires_at) VALUES($1,$1,'message',now()+interval '5 minutes')",
          [prefix],
        );
        assert.equal(
          (
            await c.query(
              "DELETE FROM auth_challenges WHERE id=$1 RETURNING id",
              [prefix],
            )
          ).rowCount,
          1,
        );
        assert.equal(
          (
            await c.query(
              "DELETE FROM auth_challenges WHERE id=$1 RETURNING id",
              [prefix],
            )
          ).rowCount,
          0,
        );
        const lock = (
          await c.query(
            "SELECT pg_try_advisory_xact_lock(hashtext($1)) AS locked",
            [prefix],
          )
        ).rows[0].locked;
        assert(lock);
        const other = await pool.connect();
        try {
          assert.equal(
            (
              await other.query(
                "SELECT pg_try_advisory_lock(hashtext($1)) AS locked",
                [prefix],
              )
            ).rows[0].locked,
            false,
          );
        } finally {
          other.release();
        }
        await c.query("ROLLBACK");
        assert.equal(
          (
            await c.query(
              "SELECT count(*)::int AS n FROM chain_transactions WHERE id=$1",
              [prefix],
            )
          ).rows[0].n,
          0,
        );
      } finally {
        await c.query("ROLLBACK");
        c.release();
      }
    } finally {
      await fixture.close();
    }
  },
);
