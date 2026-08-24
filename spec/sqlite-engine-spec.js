"use strict";

const childProcess = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { DatabaseSync } = require("node:sqlite");
const { Task } = require("lumine");
const {
  BrowseEngine,
  ReadonlyDatabase,
  browseTaskPath,
  countTaskPath,
  queryTaskPath,
  runQuery,
} = require("../lib/sqlite");
const { encodeScalar, gridCell } = require("../lib/sqlite/values");

function createFixture() {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "sqlite-view-spec-"));
  const filePath = path.join(directory, "fixture.sqlite");
  const database = new DatabaseSync(filePath);
  database.exec(`
    CREATE TABLE items(
      id INTEGER PRIMARY KEY,
      label TEXT,
      amount INTEGER,
      payload BLOB,
      generated TEXT GENERATED ALWAYS AS (label || ':' || id) VIRTUAL
    );
    CREATE INDEX items_label_index ON items(label);
    CREATE INDEX items_partial_index ON items(label) WHERE label IS NOT NULL;
    CREATE INDEX items_expression_index ON items(lower(label));
    CREATE TRIGGER items_touch AFTER UPDATE OF label ON items BEGIN SELECT 1; END;
    CREATE TABLE children(id INTEGER PRIMARY KEY, item_id INTEGER REFERENCES items(id));
    CREATE TABLE strict_items(value TEXT) STRICT;
    CREATE VIRTUAL TABLE search_docs USING fts5(body);
    INSERT INTO search_docs(body) VALUES('searchable');
    CREATE TABLE pairs(left_key TEXT, right_key INTEGER, value TEXT, PRIMARY KEY(left_key, right_key)) WITHOUT ROWID;
    CREATE TABLE "odd "" table"("semi;column" TEXT, "żółć" TEXT);
    CREATE VIEW item_names AS SELECT id, label FROM items;
  `);
  const insert = database.prepare(
    "INSERT INTO items(id, label, amount, payload) VALUES(?, ?, ?, ?)",
  );
  insert.run(1, "alpha", 1, Buffer.from([0, 1, 2]));
  insert.run(2, "beta", 9223372036854775807n, Buffer.alloc(128, 7));
  insert.run(3, "beta", -9223372036854775808n, null);
  insert.run(4, null, 4, Buffer.from([255]));
  insert.run(5, "z".repeat(5000), 5, null);
  database.prepare("INSERT INTO pairs VALUES(?, ?, ?)").run("a", 1, "first");
  database.prepare("INSERT INTO pairs VALUES(?, ?, ?)").run("a", 2, "second");
  database.prepare("INSERT INTO pairs VALUES(?, ?, ?)").run("b", 1, "third");
  database.prepare("INSERT INTO pairs VALUES(?, ?, ?)").run("b", 2, "fourth");
  database.prepare('INSERT INTO "odd "" table" VALUES(?, ?)').run("value\0with NUL", "gęślą");
  database.close();
  return { directory, filePath };
}

function forkTask(taskPath, args, onEvent = () => {}) {
  return new Promise((resolve, reject) => {
    const child = childProcess.fork(taskPath, [], { silent: true });
    const timeout = setTimeout(() => {
      child.kill();
      reject(new Error(`Timed out waiting for ${path.basename(taskPath)}.`));
    }, 10_000);
    let settled = false;
    child.on("message", (message) => {
      if (message.event === "task:completed") {
        settled = true;
        clearTimeout(timeout);
        resolve({ child, result: message.args?.[0] });
      } else {
        onEvent(message, child);
      }
    });
    child.on("error", (error) => {
      clearTimeout(timeout);
      reject(error);
    });
    child.on("exit", (code) => {
      if (!settled && code !== 0) {
        clearTimeout(timeout);
        reject(new Error(`Task exited with code ${code}.`));
      }
    });
    child.send({ event: "start", args });
  });
}

function cancelLongQuery(filePath) {
  return new Promise((resolve, reject) => {
    const child = childProcess.fork(queryTaskPath, [], { silent: true });
    const startedAt = Date.now();
    const timeout = setTimeout(() => {
      child.kill();
      reject(new Error("Timed out while cancelling a long SQLite query."));
    }, 5000);
    child.on("message", (message) => {
      if (message.event === "sqlite-view:query-event" && message.args?.[0]?.type === "start") {
        child.kill();
      }
    });
    child.on("error", (error) => {
      clearTimeout(timeout);
      reject(error);
    });
    child.on("exit", () => {
      clearTimeout(timeout);
      resolve(Date.now() - startedAt);
    });
    child.send({
      event: "start",
      args: [
        {
          path: filePath,
          id: 99,
          sql: "WITH RECURSIVE numbers(value) AS (VALUES(1) UNION ALL SELECT value + 1 FROM numbers WHERE value < 1000000000) SELECT sum(value) FROM numbers",
        },
      ],
    });
  });
}

function runLumineBrowseTask(filePath) {
  return new Promise((resolve, reject) => {
    const task = new Task(browseTaskPath);
    const timeout = setTimeout(() => {
      task.terminate();
      reject(new Error("Timed out waiting for the Lumine Task bridge."));
    }, 5000);
    task.on("sqlite-view:reply", (reply) => {
      if (reply.event !== "ready") return;
      task.send({
        event: "sqlite-view:request",
        args: [{ v: 1, epoch: 4, id: 1, revision: 2, op: "close", payload: {} }],
      });
    });
    task.on("task:error", (message) => {
      clearTimeout(timeout);
      task.terminate();
      reject(new Error(message));
    });
    task.start({ path: filePath, epoch: 4, revision: 2 }, (result) => {
      clearTimeout(timeout);
      task.terminate();
      resolve(result);
    });
  });
}

describe("SQLite engine", () => {
  let fixture;
  const engines = [];

  beforeEach(() => {
    fixture = createFixture();
  });

  afterEach(() => {
    while (engines.length > 0) engines.pop().close();
    fs.rmSync(fixture.directory, { recursive: true, force: true });
  });

  it("opens defensively and authorizes only read queries", () => {
    const database = new ReadonlyDatabase(fixture.filePath);
    engines.push({ close: () => database.close() });

    expect(database.user((db) => db.prepare("SELECT count(*) FROM items").get()[0])).toBe(5n);
    expect(database.internal((db) => db.prepare("PRAGMA trusted_schema").get()[0])).toBe(0n);
    expect(() =>
      database.user((db) => db.prepare("INSERT INTO items(label) VALUES('x')")),
    ).toThrow();
    expect(() => database.user((db) => db.prepare("CREATE TEMP TABLE forbidden(value)"))).toThrow();
    expect(() =>
      database.user((db) => db.prepare("ATTACH DATABASE ':memory:' AS other")),
    ).toThrow();
    expect(() => database.user((db) => db.prepare("PRAGMA table_info(items)"))).toThrow();
  });

  it("introspects tables, views, generated columns, indexes, and WITHOUT ROWID identities", () => {
    const engine = new BrowseEngine({ path: fixture.filePath });
    engines.push(engine);
    const catalog = engine.catalog();
    expect(catalog.objects.map((object) => object.name)).toContain("items");
    expect(catalog.objects.map((object) => object.name)).toContain("item_names");
    expect(catalog.objects.find((object) => object.name === "items_label_index").type).toBe(
      "index",
    );
    expect(catalog.objects.find((object) => object.name === "items_touch").type).toBe("trigger");
    expect(catalog.objects.find((object) => object.name === "items").sqlTruncated).toBe(false);

    const items = engine.describe("items");
    expect(items.identity.mode).toBe("rowid");
    expect(items.columns.find((column) => column.name === "generated").hidden).toBe(
      "generated-virtual",
    );
    expect(items.indexes.map((index) => index.name)).toContain("items_label_index");
    expect(items.indexes.find((index) => index.name === "items_partial_index").partial).toBe(true);
    expect(
      items.indexes.find((index) => index.name === "items_expression_index").columns[0].columnId,
    ).toBe(-2);
    expect(engine.describe("children").foreignKeys[0]).toEqual(
      jasmine.objectContaining({ from: "item_id", table: "items", to: "id" }),
    );
    expect(engine.describe("strict_items").strict).toBe(true);
    const virtual = engine.describe("search_docs");
    expect(virtual.type).toBe("virtual");
    expect(virtual.identity.mode).toBe("rowid");
    expect(
      engine.page({
        revision: engine.revision,
        source: { schema: "main", name: "search_docs" },
        columnIds: [0],
        direction: "first",
      }).rows[0].cells[0],
    ).toEqual(["t", "searchable", 0]);

    const pairs = engine.describe("pairs");
    expect(pairs.identity).toEqual({ mode: "primary-key", columnIds: [0, 1] });
    expect(engine.describe("item_names").identity.mode).toBe("offset");
    expect(engine.describe("items_touch").dataBearing).toBe(false);
  });

  it("paginates by stable key in both directions without losing duplicate values", () => {
    const engine = new BrowseEngine({ path: fixture.filePath });
    engines.push(engine);
    const base = {
      revision: engine.revision,
      source: { schema: "main", name: "items" },
      columnIds: [0, 1, 2, 3],
      sort: { columnId: 1, direction: "asc" },
      filters: [],
      rowLimit: 2,
    };
    const first = engine.page({ ...base, direction: "first" });
    const second = engine.page({ ...base, direction: "next", cursor: first.after });
    const back = engine.page({ ...base, direction: "previous", cursor: second.before });

    expect(first.pagination).toBe("keyset");
    expect(first.rows.length).toBe(2);
    expect(second.rows.length).toBe(2);
    expect(back.rows.map((row) => row.cells[0])).toEqual(first.rows.map((row) => row.cells[0]));
    const ids = [...first.rows, ...second.rows].map((row) => row.cells[0][1]);
    expect(new Set(ids).size).toBe(ids.length);
    expect(JSON.stringify(first)).toContain("9223372036854775807");

    const last = engine.page({
      ...base,
      sort: null,
      direction: "last",
      totalRows: "5",
    });
    expect(last.rows.map((row) => row.cells[0][1])).toEqual(["4", "5"]);
    expect(last.hasPrevious).toBe(true);
    expect(last.hasNext).toBe(false);

    const viewBase = {
      revision: engine.revision,
      source: { schema: "main", name: "item_names" },
      columnIds: [0, 1],
      sort: { columnId: 0, direction: "asc" },
      filters: [],
      rowLimit: 2,
    };
    const viewFirst = engine.page({ ...viewBase, direction: "first" });
    const viewSecond = engine.page({
      ...viewBase,
      direction: "next",
      cursor: viewFirst.after,
    });
    const viewBack = engine.page({
      ...viewBase,
      direction: "previous",
      cursor: viewSecond.before,
    });
    expect(viewFirst.pagination).toBe("offset");
    expect(viewBack.rows.map((row) => row.cells[0])).toEqual(
      viewFirst.rows.map((row) => row.cells[0]),
    );
  });

  it("bounds TEXT and BLOB values in pages and retrieves bounded cell details", () => {
    const engine = new BrowseEngine({ path: fixture.filePath });
    engines.push(engine);
    const page = engine.page({
      revision: engine.revision,
      source: { schema: "main", name: "items" },
      columnIds: [0, 1, 3],
      direction: "first",
    });
    const longRow = page.rows.find((row) => row.cells[0][1] === "5");
    const blobRow = page.rows.find((row) => row.cells[0][1] === "2");
    expect(longRow.cells[1][0]).toBe("t");
    expect(longRow.cells[1][1].length).toBe(4096);
    expect(longRow.cells[1][2]).toBe(1);
    expect(blobRow.cells[2]).toEqual(["b", "128", "07070707070707070707070707070707"]);

    const detail = engine.cell({
      revision: engine.revision,
      source: { schema: "main", name: "items" },
      columnId: 3,
      rowKey: blobRow.rowKey,
    });
    expect(detail.type).toBe("blob");
    expect(detail.byteLength).toBe("128");
    expect(Buffer.from(detail.base64, "base64").length).toBe(128);
  });

  it("uses a composite primary key for WITHOUT ROWID keyset pages", () => {
    const engine = new BrowseEngine({ path: fixture.filePath });
    engines.push(engine);
    const base = {
      revision: engine.revision,
      source: { schema: "main", name: "pairs" },
      columnIds: [0, 1, 2],
      rowLimit: 2,
    };
    const first = engine.page({ ...base, direction: "first" });
    const second = engine.page({ ...base, direction: "next", cursor: first.after });
    expect(first.pagination).toBe("keyset");
    expect(first.rows.map((row) => row.cells[2][1])).toEqual(["first", "second"]);
    expect(second.rows.map((row) => row.cells[2][1])).toEqual(["third", "fourth"]);
  });

  it("quotes unusual identifiers and preserves Unicode and NUL text", () => {
    const engine = new BrowseEngine({ path: fixture.filePath });
    engines.push(engine);
    const description = engine.describe('odd " table');
    expect(description.columns.map((column) => column.name)).toEqual(["semi;column", "żółć"]);
    const page = engine.page({
      revision: engine.revision,
      source: { schema: "main", name: 'odd " table' },
      columnIds: [0, 1],
      direction: "first",
    });
    expect(page.rows[0].cells).toEqual([
      ["t", "value\0with NUL", 0],
      ["t", "gęślą", 0],
    ]);
  });

  it("normalizes special numbers and text into JSON-safe tagged values", () => {
    expect(encodeScalar(-0, "real")).toEqual(["r", "-0"]);
    expect(encodeScalar(Infinity, "real")).toEqual(["r", "Infinity"]);
    expect(encodeScalar(-Infinity, "real")).toEqual(["r", "-Infinity"]);
    expect(gridCell("zażółć\0gęślą")).toEqual(["t", "zażółć\0gęślą", 0]);
    const emoji = gridCell("😀".repeat(4097));
    expect(Array.from(emoji[1])).toHaveSize(4096);
    expect(emoji[2]).toBe(1);
  });

  it("streams JSON-safe SELECT results and rejects non-read or trailing statements", () => {
    const events = [];
    const done = runQuery(
      {
        path: fixture.filePath,
        id: 7,
        sql: "WITH selected AS (SELECT id, amount FROM items) SELECT * FROM selected ORDER BY id",
      },
      (event) => events.push(event),
    );
    expect(events[0].type).toBe("start");
    expect(events.some((event) => event.type === "chunk")).toBe(true);
    expect(done.rows).toBe(5);
    expect(() => JSON.stringify(events)).not.toThrow();
    expect(JSON.stringify(events)).toContain("9223372036854775807");

    const duplicateEvents = [];
    runQuery({ path: fixture.filePath, sql: "SELECT 1 AS duplicate, 2 AS duplicate" }, (event) =>
      duplicateEvents.push(event),
    );
    expect(duplicateEvents[0].columns.map((column) => column.name)).toEqual([
      "duplicate",
      "duplicate",
    ]);
    expect(duplicateEvents.find((event) => event.type === "chunk").rows[0]).toEqual([
      ["i", "1"],
      ["i", "2"],
    ]);

    expect(() =>
      runQuery({ path: fixture.filePath, sql: "SELECT 1; DELETE FROM items" }),
    ).toThrowError(/one SQL statement/i);
    expect(() => runQuery({ path: fixture.filePath, sql: "PRAGMA table_info(items)" })).toThrow();
    expect(() => runQuery({ path: fixture.filePath, sql: "DELETE FROM items" })).toThrow();
  });

  it("detects a WAL commit and invalidates the previous revision", () => {
    const writer = new DatabaseSync(fixture.filePath);
    writer.exec("PRAGMA journal_mode = WAL");
    const engine = new BrowseEngine({ path: fixture.filePath });
    engines.push(engine);
    const revision = engine.revision;
    writer.prepare("INSERT INTO items(id, label) VALUES(?, ?)").run(6, "external");
    expect(engine.checkExternal()).toEqual({
      changed: true,
      schemaChanged: false,
      revision: revision + 1,
    });
    expect(() => engine.assertRevision(revision)).toThrowError(/changed/i);
    writer.close();
  });

  it("runs the query protocol in a cancellable child process", async () => {
    const events = [];
    const { result } = await forkTask(
      queryTaskPath,
      [{ path: fixture.filePath, id: 42, sql: "SELECT id, label FROM items ORDER BY id" }],
      (message) => {
        if (message.event === "sqlite-view:query-event") events.push(message.args[0]);
      },
    );
    expect(result.ok).toBe(true);
    expect(events.map((event) => event.type)).toContain("start");
    expect(events.map((event) => event.type)).toContain("chunk");
    expect(events.at(-1).type).toBe("done");
    expect(() => JSON.stringify(events)).not.toThrow();
  });

  it("hard-cancels SQLite while it is executing native synchronous work", async () => {
    const elapsed = await cancelLongQuery(fixture.filePath);
    expect(elapsed).toBeLessThan(3000);
  });

  it("runs exact counts in an isolated child process", async () => {
    const events = [];
    const { result } = await forkTask(
      countTaskPath,
      [
        {
          path: fixture.filePath,
          id: 13,
          request: {
            source: { schema: "main", name: "items" },
            filters: [{ columnId: 1, op: "eq", value: ["t", "beta"] }],
          },
        },
      ],
      (message) => {
        if (message.event === "sqlite-view:query-event") events.push(message.args[0]);
      },
    );
    expect(result.ok).toBe(true);
    expect(result.result.count).toBe("2");
    expect(events.at(-1).operation).toBe("count");
  });

  it("serves persistent browse requests over the Task message contract", async () => {
    const replies = [];
    let sentDescribe = false;
    const { result } = await forkTask(
      browseTaskPath,
      [{ path: fixture.filePath, epoch: 9, revision: 3 }],
      (message, child) => {
        if (message.event !== "sqlite-view:reply") return;
        const reply = message.args[0];
        replies.push(reply);
        if (reply.event === "ready" && !sentDescribe) {
          sentDescribe = true;
          child.send({
            event: "sqlite-view:request",
            args: [
              { v: 1, epoch: 9, id: 1, revision: 3, op: "describe", payload: { name: "items" } },
            ],
          });
        } else if (reply.id === 1) {
          child.send({
            event: "sqlite-view:request",
            args: [{ v: 1, epoch: 9, id: 2, revision: 3, op: "close", payload: {} }],
          });
        }
      },
    );
    expect(result.ok).toBe(true);
    expect(replies[0].event).toBe("ready");
    expect(replies.find((reply) => reply.id === 1).result.identity.mode).toBe("rowid");
    expect(replies.find((reply) => reply.id === 2).result.closed).toBe(true);
  });

  it("runs the persistent protocol through Lumine Task", async () => {
    const result = await runLumineBrowseTask(fixture.filePath);
    expect(result).toEqual({ ok: true, result: { closed: true } });
  });
});
