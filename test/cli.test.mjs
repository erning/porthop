import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { promisify } from "node:util";

const exec = promisify(execFile);
const command = new URL("../porthop", import.meta.url).pathname;
const coordinatorFixtures = new URL("fixtures/coordinator", import.meta.url).pathname;

async function rejectsWith(args, code, pattern) {
  await assert.rejects(
    exec(command, args),
    (error) => error.code === code && pattern.test(error.stderr),
  );
}

test("only implemented top-level commands are accepted", async () => {
  await rejectsWith([], 2, /Usage:\n  porthop forward set/);
  await rejectsWith(["generate"], 2, /Usage:\n  porthop forward set/);
  await rejectsWith(["client", "watch"], 2, /Usage:\n  porthop forward set/);
});

test("coordinator exposes set, fail, get, del, and list", async () => {
  const env = {
    ...process.env,
    PATH: `${coordinatorFixtures}:${process.env.PATH}`,
    PORTHOP_TOKEN: "test-token",
  };

  let result = await exec(command, ["coordinator", "set", "wg", "--port", "31001"], { env });
  assert.equal(result.stdout, "wg: port 31001, failed -\n");

  result = await exec(command, ["coordinator", "fail", "wg", "--port", "31001"], { env });
  assert.equal(result.stdout, "wg: port 31001, failed 31001\n");

  result = await exec(command, ["coordinator", "get", "wg"], { env });
  assert.equal(result.stdout, "wg: port 31001, failed 30001\n");

  result = await exec(command, ["coordinator", "list"], { env });
  assert.equal(
    result.stdout,
    "backup: port 32001, failed -\nwg: port 31001, failed 30001\n",
  );

  result = await exec(command, ["coordinator", "del", "wg", "--json"], { env });
  assert.equal(result.stdout, '{"name":"wg","deleted":true}\n');
});

test("coordinator validates local arguments before making requests", async () => {
  await rejectsWith(
    ["coordinator", "set", "wg"],
    2,
    /coordinator set requires --port/,
  );
  await rejectsWith(
    ["coordinator", "fail", "wg", "--port", "70000"],
    2,
    /invalid port: 70000/,
  );
  await rejectsWith(
    ["coordinator", "get", "bad\/name"],
    2,
    /invalid name/,
  );
});

test("server requires a channel, a WireGuard interface, and valid options", async () => {
  await rejectsWith(["server"], 2, /porthop server \[<name> <interface>\]/);
  await rejectsWith(["server", "home"], 2, /porthop server \[<name> <interface>\]/);
  await rejectsWith(
    ["server", "bad/name", "wg0"],
    2,
    /invalid name/,
  );
  await rejectsWith(
    ["server", "home", "interface-name-too-long"],
    2,
    /invalid WireGuard interface/,
  );
  await rejectsWith(
    ["server", "home", "wg0", "--dport", "51820"],
    2,
    /unknown server option: --dport/,
  );
});

test("client follows the Coordinator port before checking handshakes", async () => {
  const env = {
    ...process.env,
    PATH: `${coordinatorFixtures}:${process.env.PATH}`,
    PORTHOP_TOKEN: "test-token",
    WG_ENDPOINT: "203.0.113.10:30001",
    WG_HANDSHAKE: "0",
  };
  const result = await exec(command, ["client", "wg", "wg0"], { env });
  assert.equal(result.stdout, "wg: endpoint 30001 -> 31001, wg0\n");
});

test("client reports stale matching endpoints and accepts dry-run", async () => {
  const env = {
    ...process.env,
    PATH: `${coordinatorFixtures}:${process.env.PATH}`,
    PORTHOP_TOKEN: "test-token",
    WG_ENDPOINT: "[2001:db8::1]:31001",
    WG_HANDSHAKE: "1",
  };
  const result = await exec(
    command,
    ["client", "wg", "wg0", "--stale-after", "300", "--dry-run"],
    { env },
  );
  assert.match(
    result.stdout,
    /^wg: would report port 31001 unavailable, handshake age \d+ seconds\n$/,
  );
});

test("client leaves a fresh matching endpoint unchanged", async () => {
  const env = {
    ...process.env,
    PATH: `${coordinatorFixtures}:${process.env.PATH}`,
    PORTHOP_TOKEN: "test-token",
    WG_ENDPOINT: "203.0.113.10:31001",
    WG_HANDSHAKE: "now",
  };
  const result = await exec(command, ["client", "wg", "wg0"], { env });
  assert.match(result.stdout, /^wg: port 31001, handshake age \d+ seconds\n$/);
});

test("client validates its local arguments", async () => {
  await rejectsWith(["client"], 2, /porthop client \[<name> <interface>\]/);
  await rejectsWith(
    ["client", "wg", "wg0", "--stale-after", "later"],
    2,
    /invalid stale-after: later/,
  );
  await rejectsWith(
    ["client", "wg", "wg0", "--peer", "key"],
    2,
    /unknown client option: --peer/,
  );
});

test("client sources routine arguments from an environment file", async () => {
  const directory = await mkdtemp(join(tmpdir(), "porthop-test-"));
  const envFile = join(directory, "client.env");
  const token = join(directory, "token");
  await writeFile(token, "test-token");
  await writeFile(envFile, [
    "PORTHOP_NAME=wg",
    "PORTHOP_INTERFACE=wg0",
    `PORTHOP_TOKEN_FILE=${token}`,
    "PORTHOP_STALE_AFTER=$((1 - 1))",
    "",
  ].join("\n"));
  const env = {
    ...process.env,
    PATH: `${coordinatorFixtures}:${process.env.PATH}`,
    WG_ENDPOINT: "203.0.113.10:31001",
    WG_HANDSHAKE: "1",
  };
  const result = await exec(command, ["client", "--env", envFile, "--dry-run"], { env });
  assert.match(result.stdout, /^wg: would report port 31001 unavailable, handshake age \d+ seconds\n$/);
});

test("client command-line values override environment file values", async () => {
  const directory = await mkdtemp(join(tmpdir(), "porthop-test-"));
  const envFile = join(directory, "client.env");
  await writeFile(envFile, [
    "PORTHOP_NAME=wrong",
    "PORTHOP_INTERFACE=wrong0",
    "PORTHOP_STALE_AFTER=9999999999",
    "",
  ].join("\n"));
  const env = {
    ...process.env,
    PATH: `${coordinatorFixtures}:${process.env.PATH}`,
    PORTHOP_TOKEN: "test-token",
    WG_ENDPOINT: "203.0.113.10:31001",
    WG_HANDSHAKE: "1",
  };
  const result = await exec(
    command,
    ["client", "wg", "wg0", "--env", envFile, "--stale-after", "0", "--dry-run"],
    { env },
  );
  assert.match(result.stdout, /^wg: would report port 31001 unavailable/);
});

test("environment file option rejects unreadable and duplicate files", async () => {
  await rejectsWith(["client", "--env", "/does/not/exist"], 1, /cannot read environment file/);
  await rejectsWith(
    ["client", "--env", "/first", "--env", "/second"],
    2,
    /--env may only be specified once/,
  );
});

test("forward exposes only set, get, del, and list", async () => {
  await rejectsWith(["forward"], 2, /porthop forward set/);
  await rejectsWith(["forward", "sync"], 2, /porthop forward set/);
});

test("set requires a valid name, target port, and at least one source port", async () => {
  await rejectsWith(
    ["forward", "set", "bad/name", "--dport", "51820", "--port", "30001"],
    2,
    /invalid name/,
  );
  await rejectsWith(
    ["forward", "set", "wg", "--port", "30001"],
    2,
    /requires --dport/,
  );
  await rejectsWith(
    ["forward", "set", "wg", "--dport", "51820"],
    2,
    /requires at least one --port/,
  );
  await rejectsWith(
    ["forward", "set", "wg", "--dport", "70000", "--port", "30001"],
    2,
    /invalid port: 70000/,
  );
  await rejectsWith(
    ["forward", "set", "wg", "--dport", "51820", "--port", "0"],
    2,
    /invalid port: 0/,
  );
});

test("state-changing commands require root", async () => {
  if (process.getuid() === 0) return;
  await rejectsWith(
    ["forward", "set", "wg", "--dport", "51820", "--port", "30001"],
    1,
    /must be run as root/,
  );
  await rejectsWith(["forward", "get", "wg"], 1, /must be run as root/);
  await rejectsWith(["forward", "del", "wg"], 1, /must be run as root/);
  await rejectsWith(["forward", "list"], 1, /must be run as root/);
});
