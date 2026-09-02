const {
  DEFAULT_PAGE_SIZE,
  SQLiteCanvasGrid,
  gridOptions,
  sqliteColumns,
} = require("../lib/canvas-grid-adapter");

function props(overrides = {}) {
  return {
    dataKey: "rows:1",
    columns: [
      { key: "name", label: "Name" },
      { key: "value", label: "Value" },
    ],
    rows: [
      ["a", 1],
      ["b", 2],
    ],
    bounded: false,
    baseRow: 20,
    totalRows: 100,
    hasPrevious: true,
    hasNext: true,
    loading: false,
    ariaLabel: "SQLite rows",
    ...overrides,
  };
}

describe("SQLite CanvasGrid adapter", () => {
  let grid;

  afterEach(() => {
    grid?.destroy();
    grid = null;
  });

  it("maps bounded result sets to the offset data source", async () => {
    const options = gridOptions(props({ bounded: true, baseRow: 0, totalRows: 2 }));

    expect(options.pageSize).toBe(DEFAULT_PAGE_SIZE);
    expect(options.rowCount).toBe(2);
    expect(options.windowRows).toBeUndefined();
    expect(await options.fetchRows({ offset: 1, limit: 1 })).toEqual([["b", 2]]);
  });

  it("maps schema identity, widths, formatting, and external sort to columns", () => {
    const columns = sqliteColumns(
      [
        { id: 7, name: "name" },
        { id: 9, name: "payload" },
      ],
      { 7: 180 },
      { columnId: 9, direction: "desc" },
    );

    expect(columns[0]).toEqual(
      jasmine.objectContaining({ id: 7, key: 7, label: "name", width: 180, sortDirection: 0 }),
    );
    expect(columns[1].sortDirection).toBe(-1);
    expect(columns[1].formatCell(["t", "trimmed", 1])).toBe("trimmed…");
  });

  it("is the grid element rather than an Etch host around one", () => {
    const selectionChanged = jasmine.createSpy("selectionChanged");
    grid = new SQLiteCanvasGrid(props({ onSelectionChange: selectionChanged }));

    expect(grid.element.classList.contains("sqlite-view-grid")).toBe(true);
    expect(grid.element.querySelectorAll("canvas").length).toBe(2);
    expect(grid.element.querySelector(".sqlite-view-grid-host")).toBeNull();
    expect(grid.windowMode).toBe(true);
    expect(grid.baseRow).toBe(20);
    expect(grid.publicActiveCell()).toEqual({
      row: 20,
      column: 0,
      windowRow: 0,
    });
    expect(selectionChanged).toHaveBeenCalled();
  });

  it("updates the source, callbacks, busy state, and ARIA through one lifecycle", async () => {
    const firstConfirm = jasmine.createSpy("firstConfirm");
    const nextConfirm = jasmine.createSpy("nextConfirm");
    const nextSort = jasmine.createSpy("nextSort");
    grid = new SQLiteCanvasGrid(props({ onConfirm: firstConfirm }));
    grid.startSelection({ zone: "body", row: 1, column: 1 });

    await grid.update(
      props({
        dataKey: "rows:2",
        rows: [["c", 3]],
        baseRow: 40,
        totalRows: 41,
        hasPrevious: true,
        hasNext: false,
        loading: true,
        ariaLabel: "Updated SQLite rows",
        onConfirm: nextConfirm,
        onSort: nextSort,
      }),
    );

    expect(grid.baseRow).toBe(40);
    expect(grid.windowRows).toEqual([["c", 3]]);
    expect(grid.element.getAttribute("aria-busy")).toBe("true");
    expect(grid.element.getAttribute("aria-label")).toBe("Updated SQLite rows");
    expect(grid.options.onConfirm).toBe(nextConfirm);
    grid.requestSort(1, "descending", "test");
    const [column, index, request] = nextSort.calls.mostRecent().args;
    expect(column.key).toBe("value");
    expect(index).toBe(1);
    expect(request).toEqual({ direction: "descending", source: "test" });
  });

  it("tears down idempotently through CanvasGrid", async () => {
    grid = new SQLiteCanvasGrid(props());
    const element = grid.element;
    jasmine.attachToDOM(element);

    await grid.destroy();
    await expectAsync(grid.destroy()).toBeResolved();

    expect(grid.destroyed).toBe(true);
    expect(element.isConnected).toBe(false);
  });
});
