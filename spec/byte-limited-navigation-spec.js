const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { DatabaseSync } = require("node:sqlite");

describe("SQLite byte-limited backward navigation", () => {
  let directory, temporaryRoot, engine;

  beforeEach(async () => {
    jasmine.useRealClock();
    for (const method of ["openPath", "openExternal", "openApplication", "showItemInFolder"])
      spyOn(lumine.shell, method).and.returnValue(Promise.resolve());
    spyOn(lumine.application, "openWindow").and.returnValue(Promise.resolve());
    temporaryRoot = fs.realpathSync.native(os.tmpdir());
    directory = fs.realpathSync.native(
      fs.mkdtempSync(path.join(temporaryRoot, "sqlite-byte-navigation-")),
    );
    const filePath = path.join(directory, "wide.sqlite");
    const database = new DatabaseSync(filePath);
    try {
      const columns = Array.from({ length: 15 }, (_, index) => `value${index} TEXT`);
      database.exec(`CREATE TABLE wide(id INTEGER PRIMARY KEY, ${columns.join(",")});
        CREATE VIEW wide_view AS SELECT * FROM wide;`);
      const insert = database.prepare(`INSERT INTO wide VALUES(${Array(16).fill("?").join(",")})`);
      database.exec("BEGIN");
      for (let id = 1; id <= 80; id++) insert.run(id, ...Array(15).fill("x".repeat(4096)));
      database.exec("COMMIT");
    } finally {
      database.close();
    }
    await lumine.packages.activatePackage("sqlite-view");
    const { BrowseEngine } = require("../lib/sqlite/browse-engine");
    engine = new BrowseEngine({ path: filePath });
  });

  afterEach(() => {
    engine?.close();
    const relative = path.relative(temporaryRoot, fs.realpathSync.native(directory));
    if (
      !relative ||
      path.isAbsolute(relative) ||
      relative === ".." ||
      relative.startsWith(`..${path.sep}`)
    )
      throw new Error("Unsafe SQLite navigation cleanup");
    fs.rmSync(directory, { recursive: true, force: true });
  });

  function request(name) {
    return {
      revision: engine.revision,
      source: { schema: "main", name },
      columnIds: Array.from({ length: 16 }, (_, index) => index),
      rowLimit: 64,
      sort: { columnId: 0, direction: "asc" },
    };
  }

  for (const name of ["wide", "wide_view"]) {
    it(`includes the final row when jumping to the end of ${name}`, () => {
      const last = engine.page({ ...request(name), direction: "last", totalRows: "80" });
      const ids = last.rows.map((row) => Number(row.cells[0][1]));
      expect(last.limitedByBytes).toBe(true);
      expect(ids.at(-1)).toBe(80);
      expect(Number(last.before.offset)).toBe(ids[0] - 1);
      expect(Number(last.after.offset)).toBe(80);
      expect(last.hasNext).toBe(false);
      expect(last.hasPrevious).toBe(true);
    });

    it(`returns the adjacent preceding rows when navigating backward in ${name}`, () => {
      const base = request(name);
      let page = engine.page({ ...base, direction: "first" });
      page = engine.page({ ...base, direction: "next", cursor: page.after });
      page = engine.page({ ...base, direction: "next", cursor: page.after });
      const back = engine.page({ ...base, direction: "previous", cursor: page.before });
      const ids = back.rows.map((row) => Number(row.cells[0][1]));
      const boundary = Number(page.before.offset);
      expect(back.limitedByBytes).toBe(true);
      expect(ids.at(-1)).toBe(boundary);
      expect(Number(back.before.offset)).toBe(ids[0] - 1);
      expect(Number(back.after.offset)).toBe(boundary);
    });
  }

  it("stops an offset back page at the byte-limited first page boundary", () => {
    const base = request("wide_view");
    const first = engine.page({ ...base, direction: "first" });
    const second = engine.page({ ...base, direction: "next", cursor: first.after });
    const back = engine.page({ ...base, direction: "previous", cursor: second.before });
    expect(back.rows.map((row) => row.cells[0])).toEqual(first.rows.map((row) => row.cells[0]));
    expect(back.before.offset).toBe("0");
    expect(back.after.offset).toBe(first.after.offset);
  });
});
