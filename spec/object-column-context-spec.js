const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { DatabaseSync } = require("node:sqlite");

describe("SQLite object column context", () => {
  let directory, temporary, item, component, children;
  beforeEach(async () => {
    jasmine.useRealClock();
    for (const method of ["openExternal", "openPath", "showItemInFolder", "openApplication"])
      spyOn(lumine.shell, method).and.resolveTo();
    spyOn(lumine.application, "openWindow").and.resolveTo();
    spyOn(lumine.clipboard, "write");
    temporary = fs.realpathSync.native(os.tmpdir());
    directory = fs.realpathSync.native(
      fs.mkdtempSync(path.join(temporary, "sqlite-context-owned-")),
    );
    const file = path.join(directory, "owned.sqlite");
    const database = new DatabaseSync(file);
    try {
      database.exec(`CREATE TABLE alpha(id INTEGER PRIMARY KEY, value TEXT);
        INSERT INTO alpha VALUES(1, 'b'), (2, 'a');
        CREATE TABLE beta(id INTEGER PRIMARY KEY);
        INSERT INTO beta VALUES(3), (4);
        CREATE TABLE wide(id INTEGER PRIMARY KEY, ${Array.from({ length: 69 }, (_, index) => "value" + index + " TEXT").join(",")});
        INSERT INTO wide(id) VALUES(1);`);
    } finally {
      database.close();
    }
    const workspace = lumine.workspace.getElement();
    workspace.style.width = "1000px";
    workspace.style.height = "600px";
    jasmine.attachToDOM(lumine.workspace.getElement());
    await lumine.packages.activatePackage("sqlite-view");
    item = await lumine.workspace.open(file);
    component = item.component;
    children = [component.client.task.childProcess];
    await conditionPromise(
      () => component.selectedName === "alpha" && component.currentPage && !component.loading,
    );
    spyOn(component, "selectObject").and.callThrough();
  });
  afterEach(async () => {
    const child = component?.client?.task?.childProcess;
    if (child && !children.includes(child)) children.push(child);
    item?.destroy();
    if (lumine.packages.isPackageLoaded("sqlite-view"))
      await lumine.packages.unloadPackage("sqlite-view");
    await conditionPromise(() =>
      children.every((child) => child.exitCode != null || child.signalCode != null),
    );
    await lumine.fileWatchClient.settlePendingTeardown();
    if (
      path.dirname(fs.realpathSync.native(directory)) !== temporary ||
      !path.basename(directory).startsWith("sqlite-context-owned-")
    )
      throw Error("Unsafe SQLite context cleanup");
    fs.rmSync(directory, { recursive: true, force: true });
  });
  async function select(name) {
    component.element.querySelector('[data-object="' + name + '"]').click();
    await component.selectObject.calls.mostRecent().returnValue;
  }
  const ids = () => component.currentPage?.rows.map((row) => row.cells[0]?.[1]);
  async function sort() {
    component.refs.sortColumn.setValue(1, { emit: true });
    await conditionPromise(() => component.sortColumnId === 1);
    component.refs.sortDirection.setValue("asc", { emit: true });
    await conditionPromise(() => !component.loading && component.sort?.direction === "asc");
    expect(ids()).toEqual(["2", "1"]);
  }
  it("starts the new object without a sort column from the previous schema", async () => {
    await sort();
    await select("beta");
    expect(component.error).toBeNull();
    expect(ids()).toEqual(["3", "4"]);
    expect(component.sort).toBeNull();
  });
  it("starts the new object without filters from the previous schema", async () => {
    component.refs.filterColumn.setValue(1, { emit: true });
    await conditionPromise(() => component.filterColumnId === 1);
    component.refs.filterValue.value = "b";
    component.refs.filterValue.dispatchEvent(new Event("input", { bubbles: true }));
    component.refs.applyFilter.click();
    await conditionPromise(() => !component.loading && component.filters.length === 1);
    expect(ids()).toEqual(["1"]);
    await select("beta");
    expect(component.error).toBeNull();
    expect(ids()).toEqual(["3", "4"]);
    expect(component.filters).toEqual([]);
  });
  it("starts a narrow object's first page after actually scrolling a wide grid", async () => {
    await select("wide");
    await conditionPromise(() => component.refs.dataGrid.viewWidth > 0);
    component.refs.dataGrid.moveActiveSelectionTo(0, 65);
    await conditionPromise(() => component.visibleColumns?.start >= 32);
    await select("beta");
    expect(component.loading).toBe(false);
    expect(component.error).toBeNull();
    expect(ids()).toEqual(["3", "4"]);
  });
  it("retains the applied sort when refreshing the same object", async () => {
    await sort();
    await component.refresh();
    expect(component.error).toBeNull();
    expect(component.sort).toEqual({ columnId: 1, direction: "asc" });
    expect(ids()).toEqual(["2", "1"]);
  });
});
