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

  it("reveals its actual scrollport for a clamped navigation target without relying on scroll", () => {
    const reveal = spyOn(lumine.scrollbars, "reveal");
    grid = new SQLiteCanvasGrid(props({ bounded: true, baseRow: 0, totalRows: 2 }));
    grid.moveActiveSelectionTo(0, 0);
    reveal.calls.reset();
    grid.moveActiveSelection(-1, 0);
    expect(reveal).toHaveBeenCalledOnceWith(grid.scrollElement);
    grid.destroy();
    reveal.calls.reset();
    grid.navigate(1, 0);
    expect(reveal).not.toHaveBeenCalled();
  });

  it("extends the absolute row sizer and reveals the last row above an overlay rail", async () => {
    grid = new SQLiteCanvasGrid(
      props({
        bounded: true,
        baseRow: 0,
        totalRows: 100,
        columns: [{ key: 0, label: "Wide column", width: 600 }],
        rows: Array.from({ length: 100 }, (_, index) => [String(index)]),
      }),
    );
    grid.element.style.width = "240px";
    grid.element.style.height = "180px";
    document.body.appendChild(grid.element);
    grid.resize(240, 180);
    const scrollbar = lumine.scrollbars.attach(grid.scrollElement, {
      layout: "overlay",
      policy: "always",
    });
    try {
      await (async () => {
        for (let attempt = 0; attempt < 120; attempt++) {
          await new Promise((resolve) => requestAnimationFrame(resolve));
          if (grid.scrollEndInset > 0) return;
        }
        throw new Error("The actual horizontal overlay did not publish its end inset");
      })();
      const inset = grid.scrollEndInset;
      expect(inset).toBeGreaterThan(0);
      expect(grid.bodyViewportHeight()).toBe(grid.scrollElement.clientHeight);
      expect(parseFloat(grid.sizer.style.height)).toBe(
        grid.physicalHeight - grid.headerHeight + inset,
      );
      grid.scrollRowIntoView(99);
      expect(
        Math.abs(
          grid.scrollElement.scrollTop -
            (grid.scrollElement.scrollHeight - grid.scrollElement.clientHeight),
        ),
      ).toBeLessThan(1);
      expect(Math.abs(grid.physicalMaxScroll() - grid.scrollElement.scrollTop)).toBeLessThan(1);
      const row = grid.getCellRect(99, 0);
      const viewport = grid.getViewportRect();
      expect(row.bottom).toBeLessThanOrEqual(viewport.bottom - inset + 1);

      grid.setColumnWidth(0, 80);
      await (async () => {
        for (let attempt = 0; attempt < 120; attempt++) {
          await new Promise((resolve) => requestAnimationFrame(resolve));
          if (grid.scrollEndInset === 0) return;
        }
        throw new Error("The horizontal rail tail was not removed");
      })();
      expect(parseFloat(grid.sizer.style.height)).toBe(grid.physicalHeight - grid.headerHeight);
    } finally {
      scrollbar.dispose();
      grid.element.remove();
    }
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
