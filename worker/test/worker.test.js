import assert from "node:assert/strict";
import test from "node:test";

import worker from "../src/index.js";

const TOKEN = "test-token";

class FakeDatabase {
  constructor() {
    this.rows = new Map();
  }

  prepare(sql) {
    const database = this;
    let values = [];

    return {
      bind(...args) {
        values = args;
        return this;
      },
      async run() {
        if (sql.includes("INSERT INTO channels")) {
          const [name, port, updatedAt] = values;
          const row = database.rows.get(name);
          if (row) {
            row.port = port;
            row.updated_at = updatedAt;
          } else {
            database.rows.set(name, {
              port,
              updated_at: updatedAt,
              failed_port: null,
              failed_at: null,
            });
          }
          return { meta: { changes: 1 } };
        }

        if (sql.includes("SET failed_port")) {
          const [failedPort, failedAt, name] = values;
          const row = database.rows.get(name);
          if (!row) return { meta: { changes: 0 } };
          row.failed_port = failedPort;
          row.failed_at = failedAt;
          return { meta: { changes: 1 } };
        }

        if (sql.includes("DELETE FROM channels")) {
          const changes = database.rows.delete(values[0]) ? 1 : 0;
          return { meta: { changes } };
        }

        throw new Error(`Unexpected run query: ${sql}`);
      },
      async first() {
        const row = database.rows.get(values[0]);
        if (!row) return null;
        if (sql.includes("SELECT failed_port")) {
          return {
            failed_port: row.failed_port,
            failed_at: row.failed_at,
          };
        }
        return {
          name: values[0],
          port: row.port,
          updated_at: row.updated_at,
          failed_port: row.failed_port,
          failed_at: row.failed_at,
        };
      },
      async all() {
        if (!sql.includes("SELECT name")) {
          throw new Error(`Unexpected all query: ${sql}`);
        }
        return {
          results: [...database.rows.keys()]
            .sort()
            .map((name) => ({ name, ...database.rows.get(name) })),
        };
      },
    };
  }
}

function environment() {
  return { DB: new FakeDatabase(), TOKEN };
}

function request(path, token, method = "GET", body) {
  const init = {
    method,
    headers: token ? { Authorization: `Bearer ${token}` } : {},
  };
  if (body !== undefined) {
    init.headers["Content-Type"] = "application/json";
    init.body = JSON.stringify(body);
  }
  return new Request(`https://example.com${path}`, init);
}

test("health endpoint is public", async () => {
  const response = await worker.fetch(request("/"), environment());
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), {
    service: "porthop",
    status: "ok",
  });
});

test("channel endpoints require the shared token", async () => {
  const env = environment();

  for (const candidate of [
    request("/v1/channels"),
    request("/v1/channels/wg"),
    request("/v1/channels/wg", "wrong-token", "PUT", { port: 31001 }),
    request("/v1/channels/wg/failure"),
    request("/v1/channels/wg/failure", "wrong-token", "PUT", {
      port: 31001,
    }),
  ]) {
    const response = await worker.fetch(candidate, env);
    assert.equal(response.status, 401);
    assert.equal(response.headers.get("WWW-Authenticate"), "Bearer");
  }
});

test("current port supports upsert, listing, and ETag polling", async () => {
  const env = environment();
  const path = "/v1/channels/wg";

  let response = await worker.fetch(request(path, TOKEN), env);
  assert.equal(response.status, 404);

  response = await worker.fetch(
    request(path, TOKEN, "PUT", { port: 31001 }),
    env,
  );
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("ETag"), '"31001"');
  const created = await response.json();
  assert.equal(created.port, 31001);
  assert.equal(Number.isInteger(created.updated_at), true);

  response = await worker.fetch(request(path, TOKEN), env);
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("ETag"), '"31001"');
  assert.deepEqual(await response.json(), created);

  const conditional = request(path, TOKEN);
  conditional.headers.set("If-None-Match", '"31001"');
  response = await worker.fetch(conditional, env);
  assert.equal(response.status, 304);
  assert.equal(response.headers.get("ETag"), '"31001"');
  assert.equal(await response.text(), "");

  await worker.fetch(
    request("/v1/channels/backup", TOKEN, "PUT", { port: 32001 }),
    env,
  );
  response = await worker.fetch(request("/v1/channels", TOKEN), env);
  const listed = await response.json();
  assert.deepEqual(
    listed.channels.map((channel) => channel.name),
    ["backup", "wg"],
  );
});

test("failure state is independent from the current port", async () => {
  const env = environment();
  const path = "/v1/channels/wg";

  let response = await worker.fetch(
    request(`${path}/failure`, TOKEN, "PUT", { port: 31001 }),
    env,
  );
  assert.equal(response.status, 404);

  await worker.fetch(request(path, TOKEN, "PUT", { port: 31001 }), env);

  response = await worker.fetch(request(`${path}/failure`, TOKEN), env);
  assert.equal(response.status, 204);

  response = await worker.fetch(
    request(`${path}/failure`, TOKEN, "PUT", { port: 31001 }),
    env,
  );
  assert.equal(response.status, 200);
  const failure = await response.json();
  assert.equal(failure.failed_port, 31001);
  assert.equal(Number.isInteger(failure.failed_at), true);

  response = await worker.fetch(request(`${path}/failure`, TOKEN), env);
  assert.deepEqual(await response.json(), {
    failed_port: failure.failed_port,
    failed_at: failure.failed_at,
  });

  await worker.fetch(request(path, TOKEN, "PUT", { port: 32001 }), env);
  response = await worker.fetch(request(`${path}/failure`, TOKEN), env);
  assert.deepEqual(await response.json(), {
    failed_port: failure.failed_port,
    failed_at: failure.failed_at,
  });

  response = await worker.fetch(request(path, TOKEN), env);
  assert.equal((await response.json()).port, 32001);
});

test("deleting a channel removes its current and failure state", async () => {
  const env = environment();
  const path = "/v1/channels/wg";

  await worker.fetch(request(path, TOKEN, "PUT", { port: 31001 }), env);
  await worker.fetch(
    request(`${path}/failure`, TOKEN, "PUT", { port: 31001 }),
    env,
  );

  let response = await worker.fetch(request(path, TOKEN, "DELETE"), env);
  assert.equal(response.status, 204);

  response = await worker.fetch(request(path, TOKEN), env);
  assert.equal(response.status, 404);

  response = await worker.fetch(request(path, TOKEN, "DELETE"), env);
  assert.equal(response.status, 404);
});

test("ports must be integers between 1 and 65535", async () => {
  const env = environment();
  const channelPath = "/v1/channels/wg";

  for (const port of [0, 65536, 1.5, "31001", null]) {
    let response = await worker.fetch(
      request(channelPath, TOKEN, "PUT", { port }),
      env,
    );
    assert.equal(response.status, 400);

    response = await worker.fetch(
      request(`${channelPath}/failure`, TOKEN, "PUT", { port }),
      env,
    );
    assert.equal(response.status, 400);
  }
});

test("obsolete desired and applied endpoints are gone", async () => {
  const env = environment();
  for (const resource of ["desired", "applied"]) {
    const response = await worker.fetch(
      request(`/v1/channels/wg/${resource}`, TOKEN),
      env,
    );
    assert.equal(response.status, 404);
  }
});
