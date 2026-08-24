const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { DatabaseSync } = require("node:sqlite");
const SQLiteView = require("../lib/sqlite-view");
const main = require("../lib/main");
const { BrowseClient } = require("../lib/browse-client");
const { splitStatements, statementAt } = require("../lib/sql-statement");

function fixture() {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "sqlite-view-ui-spec-"));
  const databasePath = path.join(directory, "catalog.sqlite");
  const invalidPath = path.join(directory, "not-a-database.db");
  const corruptPath = path.join(directory, "corrupt.sqlite");
  const customPath = path.join(directory, "catalog.SQLITE-COPY");
  const database = new DatabaseSync(databasePath);
  const wideColumns = Array.from({ length: 99 }, (_, index) => `c${index + 1} INTEGER`).join(", ");
  database.exec(
    `CREATE TABLE records(id INTEGER PRIMARY KEY, name TEXT);
     INSERT INTO records VALUES(1, 'one'), (2, 'two');
     WITH RECURSIVE sequence(value) AS (VALUES(3) UNION ALL SELECT value + 1 FROM sequence WHERE value < 300)
     INSERT INTO records SELECT value, 'row-' || value FROM sequence;
     CREATE INDEX records_name_index ON records(name);
     CREATE TABLE wide(id INTEGER PRIMARY KEY, ${wideColumns});
     INSERT INTO wide(id) VALUES(1);`,
  );
  database.close();
  fs.copyFileSync(databasePath, customPath);
  fs.writeFileSync(invalidPath, "plain text", "utf8");
  const corrupt = Buffer.alloc(100);
  Buffer.from("SQLite format 3\0", "binary").copy(corrupt);
  fs.writeFileSync(corruptPath, corrupt);
  return { directory, databasePath, invalidPath, corruptPath, customPath };
}

describe("SQLite View integration", () => {
  let files;
  let timeout;

  beforeAll(() => {
    timeout = jasmine.DEFAULT_TIMEOUT_INTERVAL;
    jasmine.DEFAULT_TIMEOUT_INTERVAL = 15_000;
  });

  afterAll(() => {
    jasmine.DEFAULT_TIMEOUT_INTERVAL = timeout;
  });

  beforeEach(async () => {
    jasmine.useRealClock();
    jasmine.attachToDOM(lumine.views.getView(lumine.workspace));
    files = fixture();
    await lumine.packages.activatePackage("sqlite-view");
  });

  afterEach(async () => {
    lumine.config.unset("sqlite-view.additionalExtensions");
    const children = [];
    for (const item of lumine.workspace.getPaneItems()) {
      if (!item.getPath?.()?.startsWith(files.directory)) continue;
      const child = item.component?.client?.task?.childProcess;
      if (child) children.push(child);
      item.destroy?.();
    }
    await lumine.packages.deactivatePackage("sqlite-view");
    if (children.length) {
      await conditionPromise(
        () => children.every((child) => child.exitCode != null || child.signalCode != null),
        "SQLite child processes to exit",
      );
    }
    fs.rmSync(files.directory, { recursive: true, force: true, maxRetries: 20, retryDelay: 50 });
  });

  it("claims only supported files with a SQLite header", async () => {
    expect(main.hasSQLiteHeader(files.databasePath)).toBe(true);
    expect(main.hasSQLiteHeader(files.invalidPath)).toBe(false);

    const databaseItem = await lumine.workspace.open(files.databasePath);
    expect(databaseItem instanceof SQLiteView).toBe(true);
    try {
      await conditionPromise(
        () => databaseItem.component?.catalog || databaseItem.component?.error,
        "the SQLite catalog or error",
      );
    } catch (error) {
      const client = databaseItem.component?.client;
      throw new Error(
        `${error.message}; active=${client?.active}; pending=${client?.pending?.size}; queue=${client?.queue?.length}; task=${Boolean(client?.task)}; running=${client?.task?.isChildRunning?.()}`,
        { cause: error },
      );
    }
    expect(databaseItem.component.error).toBeNull();
    expect(databaseItem.component.catalog.objects.some((object) => object.name === "records")).toBe(
      true,
    );
    await conditionPromise(() => databaseItem.component.description, "the selected SQLite object");
    expect(databaseItem.component.description.name).toBe("records");

    const otherItem = await lumine.workspace.open(files.invalidPath);
    expect(otherItem instanceof SQLiteView).toBe(false);

    const corruptItem = await lumine.workspace.open(files.corruptPath);
    expect(corruptItem instanceof SQLiteView).toBe(true);
    await conditionPromise(() => corruptItem.component?.error, "the corrupt database error");
    expect(corruptItem.component.error.code).toBeDefined();
  });

  it("opens configured additional extensions after normalizing them", async () => {
    expect(main.normalizeExtension(" *.SQLITE-COPY ")).toBe(".sqlite-copy");
    expect(main.normalizeExtension("data")).toBe(".data");
    expect(main.normalizeExtension("../unsafe")).toBeNull();
    expect(main.normalizeExtension(".")).toBeNull();
    expect(main.isSupportedPath(files.customPath)).toBe(false);

    lumine.config.set("sqlite-view.additionalExtensions", [
      "*.SQLITE-COPY",
      ".sqlite.backup",
      "../unsafe",
    ]);

    expect(main.configuredExtensions()).toEqual(
      new Set([".sqlite", ".sqlite3", ".db", ".db3", ".sqlite-copy", ".sqlite.backup"]),
    );
    expect(main.isSupportedPath(files.customPath)).toBe(true);
    const item = await lumine.workspace.open(files.customPath);
    expect(item instanceof SQLiteView).toBe(true);
    await conditionPromise(() => item.component?.catalog, "the custom-extension database");
  });

  it("serializes view state and provides navigable schema headers", async () => {
    const item = await lumine.workspace.open(files.databasePath);
    await conditionPromise(
      () => item.component?.description || item.component?.error,
      "the selected table or error",
    );
    expect(item.component.error).toBeNull();
    item.component.mode = "query";
    item.component.queryText = "SELECT name FROM records";
    item.component.setSidebarWidth(320, false);
    item.component.setQueryEditorHeight(210, false);
    const state = item.serialize();
    expect(state.deserializer).toBe("SQLiteView");
    expect(state.viewState.queryText).toBe("SELECT name FROM records");
    expect(state.viewState.sidebarWidth).toBe(320);
    expect(state.viewState.queryEditorHeight).toBe(210);
    expect(state.viewState).not.toEqual(jasmine.objectContaining({ history: jasmine.anything() }));

    const adapter = main.provideNavigationAdapter();
    expect(adapter.handlesItem(item)).toBe(true);
    const headers = item.getNavigationHeaders();
    expect(headers.find((header) => header.text === "Tables").children[0].text).toBe("records");
  });

  it("renders a standalone index in Structure mode", async () => {
    const item = await lumine.workspace.open(files.databasePath);
    await conditionPromise(() => item.component?.catalog, "the SQLite catalog");

    await item.component.selectObject("records_name_index");

    expect(item.component.mode).toBe("structure");
    expect(item.component.description.type).toBe("index");
    expect(item.component.element.textContent).toContain("records_name_index");
    expect(item.component.element.textContent).toContain("CREATE INDEX");
  });

  it("routes workspace commands to the view selected by the event target", async () => {
    const item = await lumine.workspace.open(files.databasePath);
    await conditionPromise(
      () => item.component?.description || item.component?.error,
      "the SQLite view or error",
    );
    expect(item.component.error).toBeNull();
    spyOn(item, "refresh");
    lumine.commands.dispatch(item.element, "sqlite-view:refresh");
    expect(item.refresh).toHaveBeenCalled();
  });

  it("shows the expected icons on every toolbar button", async () => {
    const item = await lumine.workspace.open(files.databasePath);
    await conditionPromise(() => item.component?.currentPage, "the SQLite view");
    const toolbar = item.component.element.querySelector(".sqlite-view-toolbar");
    const modeButtons = [...toolbar.querySelectorAll(".btn-group .btn")];

    expect(modeButtons.map((button) => button.textContent.trim())).toEqual([
      "Data",
      "Structure",
      "Query",
    ]);
    expect(modeButtons[0].classList.contains("icon-list-unordered")).toBe(true);
    expect(modeButtons[1].classList.contains("icon-database")).toBe(true);
    expect(modeButtons[2].classList.contains("icon-code")).toBe(true);
    expect(toolbar.querySelector("button[title='Refresh']").classList.contains("icon-sync")).toBe(
      true,
    );
  });

  it("delays the visible loading state without delaying aria-busy", async () => {
    const item = await lumine.workspace.open(files.databasePath);
    await conditionPromise(() => item.component?.currentPage, "the first table page");
    const component = item.component;
    component.status = "Ready";

    component.startLoading("Loading fast table…");
    await component.patch();
    expect(component.loading).toBe(true);
    expect(component.loadingVisible).toBe(false);
    expect(component.status).toBe("Ready");
    expect(component.refs.dataGrid.grid.element.getAttribute("aria-busy")).toBe("true");
    expect(component.element.querySelector(".sqlite-view-status .loading-spinner-tiny")).toBeNull();

    component.stopLoading();
    component.status = "Fast table ready";
    await component.patch();
    await new Promise((resolve) => setTimeout(resolve, 75));
    expect(component.loadingVisible).toBe(false);
    expect(component.status).toBe("Fast table ready");

    component.startLoading("Loading slow table…");
    await component.patch();
    await conditionPromise(
      () =>
        component.loadingVisible &&
        component.element.querySelector(".sqlite-view-status .loading-spinner-tiny"),
      "the delayed loading indicator",
    );
    expect(component.status).toBe("Loading slow table…");
    component.stopLoading();
    component.status = "Slow table ready";
    await component.patch();
    expect(component.refs.dataGrid.grid.element.getAttribute("aria-busy")).toBe("false");
  });

  it("keeps the previous table painted until the next first page is ready", async () => {
    const item = await lumine.workspace.open(files.databasePath);
    await conditionPromise(() => item.component?.nextPage, "the initial three-page window");
    const component = item.component;
    const oldDescription = component.description;
    const oldDataKey = component.refs.dataGrid.props.dataKey;
    const oldRows = component.refs.dataGrid.grid.windowRows;
    const request = component.client.request.bind(component.client);
    const wideDescription = await request("describe", { name: "wide" });
    component.loadingIndicatorDelay = 10_000;
    let releaseDescription;
    let markDescriptionStarted;
    const descriptionStarted = new Promise((resolve) => {
      markDescriptionStarted = resolve;
    });
    const pendingDescription = new Promise((resolve) => {
      releaseDescription = () => resolve(wideDescription);
    });
    spyOn(component.client, "request").and.callFake((operation, payload, options) => {
      if (operation === "describe" && payload.name === "wide") {
        markDescriptionStarted();
        return pendingDescription;
      }
      return request(operation, payload, options);
    });

    const switching = component.selectObject("wide");
    await descriptionStarted;
    expect(component.loadingVisible).toBe(false);
    expect(component.getDisplayState().description).toBe(oldDescription);
    expect(component.refs.dataGrid.props.dataKey).toBe(oldDataKey);
    expect(component.refs.dataGrid.grid.windowRows).toEqual(oldRows);

    releaseDescription();
    await switching;
    expect(component.description.name).toBe("wide");
    expect(component.getDisplayState().description.name).toBe("wide");
    expect(component.refs.dataGrid.props.dataKey).not.toBe(oldDataKey);
  });

  it("loads only visible column tiles for a wide table", async () => {
    const item = await lumine.workspace.open(files.databasePath);
    await conditionPromise(() => item.component?.description, "the SQLite view");
    await item.component.selectObject("wide");
    await conditionPromise(() => item.component.currentPage, "the first wide-table page");
    const page = item.component.currentPage;

    expect(page.rows[0].cells.length).toBe(100);
    expect(page.loadedTiles.size).toBe(1);
    expect(page.rows[0].cells[64]).toEqual(["loading"]);

    item.component.handleVisibleColumns({ start: 64, end: 70 });
    await conditionPromise(() => page.loadedTiles.has(2), "the visible wide-table tile");
    expect(page.loadedTiles.size).toBeLessThanOrEqual(2);
    expect(page.rows[0].cells[64]).toBeNull();

    const resolved = await item.component.resolveGridCell({
      absoluteRow: 0,
      columnIndex: 96,
      value: ["loading"],
    });
    expect(resolved).toBeNull();
    expect(page.loadedTiles.size).toBeLessThanOrEqual(2);
  });

  it("runs the statement under the cursor", async () => {
    const item = await lumine.workspace.open(files.databasePath);
    await conditionPromise(() => item.component?.description, "the SQLite view");
    const queryEditor = item.component.refs.queryEditor.editor;
    expect(queryEditor.element.hasAttribute("input")).toBe(true);
    expect(queryEditor.isLineNumberGutterVisible()).toBe(false);
    const sql = "SELECT id, name FROM records WHERE id <= 2 ORDER BY id";
    queryEditor.setText(sql);
    item.component.executeQuery();
    await conditionPromise(
      () => !item.component.queryRunning && item.component.queryRows.length === 2,
      "the query result",
    );

    expect(item.component.mode).toBe("query");
    expect(item.component.queryColumns.map((column) => column.name)).toEqual(["id", "name"]);
    expect(item.component.queryRows[0]).toEqual([
      ["i", "1"],
      ["t", "one", 0],
    ]);
    expect(item.component.history).toBeUndefined();
  });

  it("shows query errors after Stop only inside the Query tab", async () => {
    const item = await lumine.workspace.open(files.databasePath);
    await conditionPromise(() => item.component?.currentPage, "the SQLite view");
    const component = item.component;
    const tableStatus = component.status;
    component.refs.queryEditor.editor.setText("SELECT * FROM missing_table");
    component.executeQuery();
    await conditionPromise(
      () =>
        !component.queryRunning &&
        component.queryError &&
        component.element.querySelector(".sqlite-view-query-error"),
      "the inline query error",
    );

    const actions = component.element.querySelector(".sqlite-view-query-actions");
    const stop = actions.querySelector("button.icon-primitive-square");
    const queryError = actions.querySelector(".sqlite-view-query-error");
    expect(actions.querySelector("select")).toBeNull();
    expect(stop.nextElementSibling).toBe(queryError);
    expect(queryError.textContent).toContain("SQLITE_ERROR");
    expect(queryError.textContent).toContain("no such table");
    expect(component.error).toBeNull();
    expect(component.status).toBe(tableStatus);
    expect(component.element.querySelector(".sqlite-view-error")).toBeNull();

    component.mode = "data";
    await component.patch();
    expect(component.refs.queryPanel.classList.contains("is-hidden")).toBe(true);
    expect(component.element.querySelector(".sqlite-view-status").textContent).not.toContain(
      "no such table",
    );
  });

  it("restores a missing database and reopens it when the file reappears", async () => {
    const missingPath = path.join(files.directory, "restored.sqlite");
    const item = main.deserialize({
      path: missingPath,
      viewState: { mode: "query", queryText: "SELECT 42" },
    });
    await lumine.workspace.open(item);
    expect(item instanceof SQLiteView).toBe(true);
    expect(item.component.error.code).toBe("FILE_DELETED");

    const database = new DatabaseSync(missingPath);
    database.exec("CREATE TABLE restored(value INTEGER); INSERT INTO restored VALUES(42)");
    database.close();
    await conditionPromise(() => item.component.catalog, "the restored SQLite catalog");

    expect(item.component.error).toBeNull();
    expect(item.component.queryText).toBe("SELECT 42");
    expect(item.component.catalog.objects.some((object) => object.name === "restored")).toBe(true);
  });
});

describe("SQL statement selection", () => {
  const sql = "SELECT ';' AS semicolon; -- ;\nSELECT 2 /* ; */; SELECT 3";

  it("does not split semicolons inside strings or comments", () => {
    expect(splitStatements(sql).map((entry) => entry.text.trim())).toEqual([
      "SELECT ';' AS semicolon;",
      "-- ;\nSELECT 2 /* ; */;",
      "SELECT 3",
    ]);
  });

  it("does not split semicolons inside quoted identifiers", () => {
    expect(splitStatements("SELECT [semi;colon], `also;quoted`; SELECT 2")).toHaveSize(2);
  });

  it("returns the statement containing the cursor", () => {
    expect(statementAt(sql, sql.indexOf("SELECT 2"))).toContain("SELECT 2");
    expect(statementAt(sql, sql.length)).toBe("SELECT 3");
  });
});

describe("browse request coordination", () => {
  it("replaces queued viewport work with the newest request", async () => {
    const client = Object.create(BrowseClient.prototype);
    client.destroyed = false;
    client.queue = [];
    client.pump = () => {};
    const first = client
      .request("page", { tile: 1 }, { replaceKey: "visible:1:0" })
      .catch((error) => error);
    client.request("page", { tile: 2 }, { replaceKey: "visible:1:0" });

    expect((await first).code).toBe("SUPERSEDED");
    expect(client.queue.map((entry) => entry.payload.tile)).toEqual([2]);
  });
});
