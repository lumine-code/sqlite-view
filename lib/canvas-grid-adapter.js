const { CanvasGrid } = require("@lumine-code/canvas-grid");

const DEFAULT_PAGE_SIZE = 256;

function formatCell(value) {
  if (value == null) return "NULL";
  if (!Array.isArray(value)) return String(value);
  if (value[0] === "loading") return "Loading…";
  if (value[0] === "b") return `<BLOB ${value[1]} bytes>${value[2] ? ` ${value[2]}` : ""}`;
  if (value[0] === "t") return `${value[1]}${value[2] ? "…" : ""}`;
  return value[1];
}

function sqliteColumns(columns, widths = {}, sort = null) {
  return columns.map((column, index) => {
    const id = column.id ?? index;
    return {
      id,
      key: id,
      label: column.name || column.columnName || `Column ${index + 1}`,
      name: column.name || column.columnName || `Column ${index + 1}`,
      width: Number(widths[id]) || 140,
      sortDirection: sort?.columnId === id ? (sort.direction === "asc" ? 1 : -1) : 0,
      formatCell,
    };
  });
}

function pageRows(rows) {
  return async ({ offset, limit }) => rows.slice(offset, offset + limit);
}

function callbacks(props) {
  return {
    onSelectionChange: props.onSelectionChange,
    onConfirm: props.onConfirm,
    onSort: props.onSort,
    onError: props.onError,
    onNeedPrevious: props.onNeedPrevious,
    onNeedNext: props.onNeedNext,
    onRequestEnd: props.onRequestEnd,
    onVisibleColumnsChange: props.onVisibleColumnsChange,
    resolveCell: props.resolveCell,
  };
}

function gridOptions(props) {
  const common = {
    className: "sqlite-view-grid",
    commandPrefix: "sqlite-view",
    columns: props.columns,
    pageSize: DEFAULT_PAGE_SIZE,
    busy: props.loading,
    ariaLabel: props.ariaLabel,
    ...callbacks(props),
  };

  if (props.bounded) {
    return {
      ...common,
      rowCount: props.rows.length,
      fetchRows: pageRows(props.rows),
    };
  }

  return {
    ...common,
    baseRow: props.baseRow,
    windowRows: props.rows,
    hasPrevious: props.hasPrevious,
    hasNext: props.hasNext,
    totalRows: props.totalRows,
  };
}

/**
 * Etch-compatible SQLite mapping for the host-neutral CanvasGrid. The element,
 * selection state, commands, observers, and teardown remain owned by CanvasGrid;
 * this class only translates bounded and keyset-backed row sources.
 */
class SQLiteCanvasGrid extends CanvasGrid {
  constructor(props) {
    super(gridOptions(props));
    this.props = props;
    this.ensureInitialSelection();
  }

  update(props) {
    const previous = this.props;
    this.props = props;
    this.updateOptions({ ...callbacks(props), ariaLabel: props.ariaLabel });
    this.element.setAttribute("aria-label", props.ariaLabel || "Data grid");

    if (props.dataKey !== previous.dataKey || props.bounded !== previous.bounded)
      this.updateSource(props);
    this.ensureInitialSelection();
    this.setBusy(Boolean(props.loading));

    return Promise.resolve();
  }

  updateSource(props) {
    if (props.bounded) {
      this.setData({
        columns: props.columns,
        rowCount: props.rows.length,
        pageSize: DEFAULT_PAGE_SIZE,
        fetchRows: pageRows(props.rows),
      });
      return;
    }

    this.setWindow({
      baseRow: props.baseRow,
      rows: props.rows,
      hasPrevious: props.hasPrevious,
      hasNext: props.hasNext,
      totalRows: props.totalRows,
      columns: props.columns,
    });
  }

  ensureInitialSelection() {
    if (!this.selection && this.rowCount && this.columns.length) {
      this.moveActiveSelectionTo(0, 0);
    }
  }

  destroy() {
    this.props = null;
    super.destroy();
    return Promise.resolve();
  }
}

module.exports = {
  DEFAULT_PAGE_SIZE,
  SQLiteCanvasGrid,
  formatCell,
  gridOptions,
  sqliteColumns,
};
