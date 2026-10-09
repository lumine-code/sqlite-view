const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { DatabaseSync } = require("node:sqlite");

describe("SQLite backward page column alignment", () => {
  let directory, temporaryRoot, item, component, child;

  beforeEach(async () => {
    jasmine.useRealClock();
    jasmine.attachToDOM(lumine.workspace.getElement());
    for (const method of ["openPath", "openExternal", "openApplication", "showItemInFolder"])
      spyOn(lumine.shell, method).and.returnValue(Promise.resolve());
    spyOn(lumine.application, "openWindow").and.returnValue(Promise.resolve());
    temporaryRoot = fs.realpathSync.native(os.tmpdir());
    directory = fs.realpathSync.native(
      fs.mkdtempSync(path.join(temporaryRoot, "sqlite-tile-alignment-")),
    );
    const filePath = path.join(directory, "wide.sqlite");
    const database = new DatabaseSync(filePath);
    try {
      const columns = Array.from({ length: 63 }, (_, index) => `value${index} TEXT`);
      database.exec(`CREATE TABLE wide(id INTEGER PRIMARY KEY, ${columns.join(",")});
        CREATE TABLE inverse(id INTEGER PRIMARY KEY, ${columns.join(",")})`);
      const insert = database.prepare(`INSERT INTO wide VALUES(${Array(64).fill("?").join(",")})`);
      const insertInverse = database.prepare(
        `INSERT INTO inverse VALUES(${Array(64).fill("?").join(",")})`,
      );
      database.exec("BEGIN");
      for (let id = 1; id <= 40; id++) {
        insert.run(id, ...Array(31).fill("short"), ...Array(32).fill("x".repeat(4096)));
        insertInverse.run(id, ...Array(31).fill("x".repeat(4096)), ...Array(32).fill("short"));
      }
      database.exec("COMMIT");
    } finally {
      database.close();
    }
    await lumine.packages.activatePackage("sqlite-view");
    item = await lumine.workspace.open(filePath);
    component = item.component;
    child = component.client.task.childProcess;
    await conditionPromise(
      () => component.currentPage && !component.loading,
      "actual SQLite first page",
    );
  });

  afterEach(async () => {
    item?.destroy();
    if (child)
      await conditionPromise(
        () => child.exitCode != null || child.signalCode != null,
        "owned SQLite browse process exit",
      );
    await lumine.fileWatchClient.settlePendingTeardown();
    const relative = path.relative(temporaryRoot, fs.realpathSync.native(directory));
    if (
      !relative ||
      path.isAbsolute(relative) ||
      relative === ".." ||
      relative.startsWith(`..${path.sep}`)
    )
      throw new Error("Unsafe SQLite tile cleanup");
    fs.rmSync(directory, { recursive: true, force: true });
  });

  it("retains the same row identities when a wider column tile shortens the last page", async () => {
    await component.selectObject("wide");
    await component.countRows({ goToEnd: true });
    const page = component.currentPage;
    expect(page.rows.at(-1).cells[0][1]).toBe("40");
    const result = await component.client.request("page", {
      source: { schema: "main", name: "wide" },
      columnIds: Array.from({ length: 32 }, (_, index) => index + 32),
      direction: "last",
      totalRows: "40",
      rowLimit: 256,
    });
    expect(result.limitedByBytes).toBe(true);
    expect(result.rows.length).toBeLessThan(page.rows.length);
    component.applyPageTile(page, result, 1);
    expect(page.rows.map((row) => row.cells[0][1])).toEqual(
      result.rows.map((row) => row.rowKey.values[0][1]),
    );
    expect(page.rows.at(-1).cells[0][1]).toBe("40");
    expect(page.before.offset).toBe(result.before.offset);
    expect(page.after.offset).toBe("40");
  });

  it("keeps the narrower loaded window when a smaller column tile returns more leading rows", async () => {
    await component.selectObject("inverse");
    await component.countRows({ goToEnd: true });
    const page = component.currentPage;
    const expectedIds = page.rows.map((row) => row.cells[0][1]);
    const before = page.before.offset;
    expect(expectedIds.at(-1)).toBe("40");
    const result = await component.client.request("page", {
      source: { schema: "main", name: "inverse" },
      columnIds: Array.from({ length: 32 }, (_, index) => index + 32),
      direction: "last",
      totalRows: "40",
      rowLimit: 256,
    });
    expect(result.rows.length).toBeGreaterThan(page.rows.length);
    component.applyPageTile(page, result, 1);
    expect(page.rows.map((row) => row.cells[0][1])).toEqual(expectedIds);
    expect(page.rows.map((row) => row.rowKey.values[0][1])).toEqual(expectedIds);
    expect(page.before.offset).toBe(before);
    expect(page.after.offset).toBe("40");
  });
});
