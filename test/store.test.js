import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PgStore } from '../src/store.js';

test('failed transaction rolls back and releases the client', async () => {
  const queries = [], releases = [];
  const client = Object.assign(new EventEmitter(), { query: async (sql) => {
    queries.push(sql);
    if (!['BEGIN', 'ROLLBACK'].includes(sql)) throw new Error('synthetic-db-failure');
  }, release: broken => releases.push(broken) });
  const store = new PgStore({ connect: async () => client });
  await assert.rejects(store.save([{ eventId: 'synthetic-event' }]));
  assert.equal(queries[0], 'BEGIN');
  assert.equal(queries.at(-1), 'ROLLBACK');
  assert.equal(queries.includes('COMMIT'), false);
  assert.deepEqual(releases, [false]);
});

test('client is discarded if rollback fails', async () => {
  const releases = [];
  const client = Object.assign(new EventEmitter(), { query: async sql => {
    if (sql !== 'BEGIN') throw new Error('synthetic-connection-lost');
  }, release: broken => releases.push(broken) });
  const store = new PgStore({ connect: async () => client });
  await assert.rejects(store.save([{ eventId: 'synthetic-event' }]));
  assert.deepEqual(releases, [true]);
});

test('connection acquisition failure is propagated and no empty batch opens a connection', async () => {
  let connects = 0;
  const store = new PgStore({ connect: async () => { connects++; throw new Error('synthetic-timeout'); } });
  assert.equal(await store.save([]), 0);
  await assert.rejects(store.save([{ eventId: 'synthetic-event' }]));
  assert.equal(connects, 1);
});

test('checked-out transport error is handled without an unhandled error event or client leak', async () => {
  const releases = [];
  const client = Object.assign(new EventEmitter(), {
    query: async sql => {
      if (sql === 'BEGIN') {
        client.emit('error', new Error('synthetic-transport-failure'));
        throw new Error('synthetic-disconnected');
      }
      throw new Error('synthetic-disconnected');
    },
    release: broken => releases.push(broken),
  });
  const store = new PgStore({ connect: async () => client });
  await assert.rejects(store.save([{ eventId: 'synthetic-event' }]));
  assert.deepEqual(releases, [true]);
  assert.equal(client.listenerCount('error'), 0);
});
