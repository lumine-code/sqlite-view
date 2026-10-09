const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { DatabaseSync } = require("node:sqlite");

describe("SQLite browse publication ownership", () => {
  let directory, file, item, component, children;
  async function ready(name) {
    await conditionPromise(
      () => component?.selectedName === name && component.currentPage && !component.loading,
      `SQLite table ${name}`,
    );
    await component.patch();
  }
  beforeEach(async () => {
    jasmine.useRealClock();
    jasmine.attachToDOM(lumine.workspace.getElement());
    children = [];
    directory = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), "sqlite-owner-")));
    file = path.join(directory, "owned.sqlite");
    const database = new DatabaseSync(file);
    database.exec(`CREATE TABLE a(id INTEGER PRIMARY KEY, value TEXT);
      INSERT INTO a VALUES(1, 'A-one'), (2, 'A-two');
      CREATE TABLE b(id INTEGER PRIMARY KEY, value TEXT);
      INSERT INTO b VALUES(1, 'B-one');`);
    database.close();
    await lumine.packages.deactivatePackage("sqlite-view");
    await lumine.packages.activatePackage("sqlite-view");
    item = await lumine.workspace.open(file);
    component = item.component;
    children.push(component.client.task.childProcess);
    await ready("a");
  });
  afterEach(async () => {
    item?.destroy();
    await lumine.packages.deactivatePackage("sqlite-view");
    await conditionPromise(
      () => children.every((child) => child.exitCode != null || child.signalCode != null),
      "owned SQLite child processes to exit",
    );
    await lumine.fileWatchClient.settlePendingTeardown();
    const relative = path.relative(fs.realpathSync.native(os.tmpdir()), directory);
    if (path.isAbsolute(relative) || relative === ".." || relative.startsWith(`..${path.sep}`)) {
      throw new Error("Unsafe SQLite fixture cleanup");
    }
    fs.rmSync(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  });
  function selectB() {
    [...component.element.querySelectorAll(".sqlite-view-object")]
      .find((button) => button.textContent === "b")
      .click();
    return ready("b");
  }
  function delayCell() {
    let finish;
    const request = component.client.request.bind(component.client);
    spyOn(component.client, "request").and.callFake((op, ...args) => {
      const result = request(op, ...args);
      return op === "cell"
        ? result.then((value) => new Promise((resolve) => (finish = () => resolve(value))))
        : result;
    });
    return {
      get finish() {
        return finish;
      },
    };
  }
  function confirm(column = 1) {
    const grid = component.refs.dataGrid;
    grid.moveActiveSelectionTo(0, column);
    return lumine.commands.dispatch(grid.element, "core:confirm");
  }
  function delayCatalogPaint() {
    const previous = component.catalog;
    const patch = component.patch.bind(component);
    let held = false,
      finish;
    spyOn(component, "patch").and.callFake(() => {
      const hold = !held && component.catalog !== previous;
      if (hold) held = true;
      const painted = patch();
      return hold ? painted.then(() => new Promise((resolve) => (finish = resolve))) : painted;
    });
    return {
      get finish() {
        return finish;
      },
    };
  }

  it("does not publish an old actual count into the newly selected table", async () => {
    let finish;
    const runCount = component.client.runCount.bind(component.client);
    spyOn(component.client, "runCount").and.callFake((payload) => {
      const result = runCount(payload);
      children.push(component.client.countTask.childProcess);
      return result.then((value) => new Promise((resolve) => (finish = () => resolve(value))));
    });
    const count = spyOn(component, "countRows").and.callThrough();
    [...component.element.querySelectorAll("button")]
      .find((button) => button.textContent === "Count")
      .click();
    await conditionPromise(() => finish, "actual SQLite count result");
    await selectB();
    finish();
    await count.calls.mostRecent().returnValue;
    expect(component.selectedName).toBe("b");
    expect(component.totalRows).toBeNull();
    expect(component.element.querySelector(".sqlite-view-row-count")).toBeNull();
    expect(component.refs.dataGrid.element.getAttribute("aria-rowcount")).not.toBe("2");
  });

  it("does not reveal an old actual cell detail under a different table", async () => {
    const delayed = delayCell();
    const show = spyOn(component, "showCell").and.callThrough();
    await confirm();
    await conditionPromise(() => delayed.finish, "actual SQLite cell result");
    await selectB();
    delayed.finish();
    await show.calls.mostRecent().returnValue;
    expect(component.selectedName).toBe("b");
    expect(component.cellDetail).toBeNull();
    expect(component.element.querySelector(".sqlite-view-cell-detail")).toBeNull();
  });

  it("keeps a user-closed detail closed when another actual cell result arrives", async () => {
    await confirm();
    await conditionPromise(() => component.cellDetail, "initial actual cell detail");
    await component.patch();
    const delayed = delayCell();
    const show = spyOn(component, "showCell").and.callThrough();
    await confirm(0);
    await conditionPromise(() => delayed.finish, "second actual cell result");
    component.element.querySelector(".sqlite-view-cell-detail-close").click();
    await component.patch();
    delayed.finish();
    await show.calls.mostRecent().returnValue;
    expect(component.cellDetail).toBeNull();
    expect(component.element.querySelector(".sqlite-view-cell-detail")).toBeNull();
  });

  it("keeps current count and cell detail publication working", async () => {
    await component.countRows();
    expect(component.totalRows).toBe("2");
    expect(component.element.querySelector(".sqlite-view-row-count").textContent.trim()).toBe(
      "2 rows",
    );
    await confirm();
    await conditionPromise(() => component.cellDetail, "current actual cell detail");
    expect(component.cellDetail.value).toBe("A-one");
  });

  it("confirms the focused schema object through actual Core keyboard commands", async () => {
    const b = [...component.element.querySelectorAll(".sqlite-view-object")].find(
      (button) => button.textContent === "b",
    );
    b.focus();
    await lumine.commands.dispatch(b, "core:confirm");
    // Await the command-owned async selection when it was actually invoked.
    if (component.selectedName === "b") await ready("b");
    expect(component.selectedName).toBe("b");
    expect(b.getAttribute("data-object")).toBe("b");
    expect(b.getAttribute("aria-selected")).toBe("true");
  });

  it("keeps a stopped count unpublished even when its actual worker result is ready", async () => {
    let finish;
    const runCount = component.client.runCount.bind(component.client);
    spyOn(component.client, "runCount").and.callFake((payload) => {
      const result = runCount(payload);
      children.push(component.client.countTask.childProcess);
      return result.then((value) => new Promise((resolve) => (finish = () => resolve(value))));
    });
    const count = component.countRows();
    await conditionPromise(() => finish, "actual count result before Stop");
    await component.patch();
    [...component.element.querySelectorAll("button")]
      .find((button) => button.textContent === "Stop")
      .click();
    finish();
    await count;
    expect(component.totalRows).toBeNull();
    expect(component.counting).toBe(false);
  });

  it("publishes the schema splitter accessible value and orientation in the DOM", () => {
    const splitter = component.refs.sidebarResizer;
    expect(splitter.getAttribute("role")).toBe("separator");
    expect(splitter.getAttribute("aria-orientation")).toBe("vertical");
    expect(splitter.getAttribute("aria-valuemin")).toBe("180");
    expect(splitter.getAttribute("aria-valuemax")).toBe("600");
    expect(splitter.getAttribute("aria-valuenow")).toBe(String(component.sidebarWidth));
  });

  it("does not let a post-catalog repaint replace a newer selected table", async () => {
    const delayed = delayCatalogPaint();
    const loading = component.loadCatalog();
    await conditionPromise(() => delayed.finish, "actual post-catalog repaint");
    await selectB();
    delayed.finish();
    await loading;
    expect(component.selectedName).toBe("b");
    expect(component.description.name).toBe("b");
  });

  it("does not revive a destroyed view after its post-catalog repaint", async () => {
    const delayed = delayCatalogPaint();
    const loading = component.loadCatalog();
    await conditionPromise(() => delayed.finish, "actual post-catalog repaint before close");
    item.destroy();
    delayed.finish();
    await loading;
    expect(component.destroyed).toBe(true);
    expect(component.loading).toBe(false);
  });
});
