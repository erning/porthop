const NAME_PATTERN = /^[A-Za-z0-9_.-]+$/;

export default {
  async fetch(request, env) {
    try {
      return await handleRequest(request, env);
    } catch (error) {
      console.error("Unhandled error:", error);
      return json({ error: "internal server error" }, 500);
    }
  },
};

async function handleRequest(request, env) {
  const url = new URL(request.url);

  if (url.pathname === "/" && request.method === "GET") {
    return json({ service: "porthop", status: "ok" });
  }

  if (url.pathname === "/v1/channels") {
    if (!authorized(request, env.TOKEN)) return unauthorized();
    if (request.method !== "GET") return methodNotAllowed("GET");
    return listChannels(env.DB);
  }

  const match = url.pathname.match(
    /^\/v1\/channels\/([A-Za-z0-9_.-]+)(\/failure)?$/,
  );

  if (!match) return json({ error: "not found" }, 404);
  if (!authorized(request, env.TOKEN)) return unauthorized();

  const name = match[1];
  if (!NAME_PATTERN.test(name)) {
    return json({ error: "invalid channel name" }, 400);
  }

  if (match[2]) {
    if (request.method === "GET") return getFailure(env.DB, name);
    if (request.method === "PUT") return putFailure(request, env.DB, name);
    return methodNotAllowed("GET, PUT");
  }

  if (request.method === "GET") return getChannel(request, env.DB, name);
  if (request.method === "PUT") return putChannel(request, env.DB, name);
  if (request.method === "DELETE") return deleteChannel(env.DB, name);
  return methodNotAllowed("GET, PUT, DELETE");
}

async function listChannels(db) {
  const result = await db
    .prepare(`
      SELECT name, port, updated_at, failed_port, failed_at
      FROM channels
      ORDER BY name
    `)
    .all();

  return json({ channels: result.results });
}

async function getChannel(request, db, name) {
  const row = await db
    .prepare(`
      SELECT name, port, updated_at, failed_port, failed_at
      FROM channels
      WHERE name = ?
    `)
    .bind(name)
    .first();

  if (!row || row.port === null) {
    return json({ error: "channel not found" }, 404);
  }

  const etag = `"${row.port}"`;
  if (request.headers.get("If-None-Match") === etag) {
    return new Response(null, {
      status: 304,
      headers: commonHeaders({ ETag: etag }, false),
    });
  }

  return json(
    row,
    200,
    { ETag: etag },
  );
}

async function putChannel(request, db, name) {
  const body = await readJson(request);
  if (!body) return json({ error: "invalid JSON body" }, 400);
  if (!validPort(body.port)) {
    return json({ error: `invalid port: ${body.port}` }, 400);
  }

  const now = unixTime();
  await db
    .prepare(`
      INSERT INTO channels (name, port, updated_at)
      VALUES (?, ?, ?)
      ON CONFLICT(name) DO UPDATE SET
        port = excluded.port,
        updated_at = excluded.updated_at
    `)
    .bind(name, body.port, now)
    .run();

  const row = await findChannel(db, name);
  return json(row, 200, { ETag: `"${body.port}"` });
}

async function deleteChannel(db, name) {
  const result = await db
    .prepare("DELETE FROM channels WHERE name = ?")
    .bind(name)
    .run();

  if (!result.meta || result.meta.changes !== 1) {
    return json({ error: "channel not found" }, 404);
  }

  return new Response(null, {
    status: 204,
    headers: commonHeaders({}, false),
  });
}

async function getFailure(db, name) {
  const row = await db
    .prepare("SELECT failed_port, failed_at FROM channels WHERE name = ?")
    .bind(name)
    .first();

  if (!row) return json({ error: "channel not found" }, 404);
  if (row.failed_port === null) {
    return new Response(null, {
      status: 204,
      headers: commonHeaders({}, false),
    });
  }

  return json({ failed_port: row.failed_port, failed_at: row.failed_at });
}

async function putFailure(request, db, name) {
  const body = await readJson(request);
  if (!body) return json({ error: "invalid JSON body" }, 400);
  if (!validPort(body.port)) {
    return json({ error: `invalid port: ${body.port}` }, 400);
  }

  const now = unixTime();
  const result = await db
    .prepare(`
      UPDATE channels
      SET failed_port = ?, failed_at = ?
      WHERE name = ?
    `)
    .bind(body.port, now, name)
    .run();

  if (!result.meta || result.meta.changes !== 1) {
    return json({ error: "channel not found" }, 404);
  }

  return json(await findChannel(db, name));
}

function findChannel(db, name) {
  return db
    .prepare(`
      SELECT name, port, updated_at, failed_port, failed_at
      FROM channels
      WHERE name = ?
    `)
    .bind(name)
    .first();
}

function validPort(port) {
  return Number.isInteger(port) && port >= 1 && port <= 65535;
}

function unixTime() {
  return Math.floor(Date.now() / 1000);
}

function authorized(request, expectedToken) {
  if (typeof expectedToken !== "string" || expectedToken.length === 0) {
    return false;
  }
  return request.headers.get("Authorization") === `Bearer ${expectedToken}`;
}

function unauthorized() {
  return json({ error: "unauthorized" }, 401, {
    "WWW-Authenticate": "Bearer",
  });
}

function methodNotAllowed(allow) {
  return json({ error: "method not allowed" }, 405, { Allow: allow });
}

async function readJson(request) {
  try {
    return await request.json();
  } catch {
    return null;
  }
}

function commonHeaders(extra = {}, includeContentType = true) {
  const headers = {
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff",
    ...extra,
  };

  if (includeContentType) {
    headers["Content-Type"] = "application/json; charset=utf-8";
  }

  return headers;
}

function json(body, status = 200, extraHeaders = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: commonHeaders(extraHeaders),
  });
}
