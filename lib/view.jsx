/** @jsx etch.dom */
const etch = require("@lumine-code/etch");
const { CompositeDisposable, Disposable } = require("lumine");
const { BrowseClient } = require("./browse-client");
const QueryEditor = require("./query-editor");
const { statementAt } = require("./sql-statement");

const PAGE_ROWS = 256;
const COLUMN_TILE = 32;
const MAX_PAGE_COLUMN_TILES = 2;
const HISTORY_LIMIT = 50;
const LOADING_INDICATOR_DELAY_MS = 50;
const LOADING_CELL = Object.freeze(["loading"]);

class GridHost {
  constructor(props) {
    this.props = props;
    etch.initialize(this);
    this.mountGrid();
  }

  mountGrid() {
    const exported = require("./canvas-grid");
    const CanvasGrid = exported.CanvasGrid || exported;
    this.grid = new CanvasGrid(this.gridProps());
    this.element.appendChild(this.grid.element);
  }

  gridProps() {
    const { columns, rows } = this.props;
    if (this.props.bounded) {
      return {
        columns,
        rowCount: rows.length,
        pageSize: PAGE_ROWS,
        fetchRows: async ({ offset, limit }) => rows.slice(offset, offset + limit),
        onSelectionChange: this.props.onSelectionChange,
        onConfirm: this.props.onConfirm,
        onSort: this.props.onSort,
        onError: this.props.onError,
        busy: this.props.loading,
        ariaLabel: this.props.ariaLabel,
      };
    }
    return {
      columns,
      pageSize: PAGE_ROWS,
      baseRow: this.props.baseRow,
      windowRows: rows,
      hasPrevious: this.props.hasPrevious,
      hasNext: this.props.hasNext,
      totalRows: this.props.totalRows,
      onSelectionChange: this.props.onSelectionChange,
      onConfirm: this.props.onConfirm,
      onSort: this.props.onSort,
      onNeedPrevious: this.props.onNeedPrevious,
      onNeedNext: this.props.onNeedNext,
      onRequestEnd: this.props.onRequestEnd,
      onError: this.props.onError,
      busy: this.props.loading,
      onVisibleColumnsChange: this.props.onVisibleColumnsChange,
      resolveCell: this.props.resolveCell,
      ariaLabel: this.props.ariaLabel,
    };
  }

  update(props) {
    const changed = props.dataKey !== this.props.dataKey;
    this.props = props;
    this.grid.setBusy?.(props.loading);
    if (changed) {
      if (!props.bounded && this.grid.setWindow) {
        this.grid.setWindow({
          baseRow: props.baseRow,
          rows: props.rows,
          hasPrevious: props.hasPrevious,
          hasNext: props.hasNext,
          totalRows: props.totalRows,
          columns: props.columns,
        });
      } else {
        this.grid.setData?.({
          columns: props.columns,
          rowCount: props.rows.length,
          pageSize: PAGE_ROWS,
          fetchRows: async ({ offset, limit }) => props.rows.slice(offset, offset + limit),
        });
      }
    }
    return Promise.resolve();
  }

  focus() {
    this.grid.focus();
  }

  copySelection() {
    return this.grid.copySelection();
  }

  destroy() {
    this.grid?.destroy();
    return etch.destroy(this);
  }

  render() {
    return <div className="sqlite-view-grid-host" />;
  }
}

class SQLiteViewComponent {
  constructor(props) {
    this.props = props;
    const saved = props.state || {};
    this.mode = saved.mode || "data";
    this.queryText = saved.queryText || "";
    this.selectedName = saved.selectedObject || null;
    this.sort = saved.sort || null;
    this.filters = Array.isArray(saved.filters) ? saved.filters.slice(0, 8) : [];
    this.columnWidths = saved.columnWidths || {};
    this.sidebarWidth = Math.min(600, Math.max(180, Number(saved.sidebarWidth) || 260));
    this.queryEditorHeight = Math.min(600, Math.max(96, Number(saved.queryEditorHeight) || 180));
    this.showSystem = Boolean(saved.showSystem);
    this.history = [];
    this.collapsedGroups = new Set();
    this.queryColumns = [];
    this.queryRows = [];
    this.queryError = null;
    this.status = "";
    this.loading = false;
    this.loadingVisible = false;
    this.loadingIndicatorDelay = LOADING_INDICATOR_DELAY_MS;
    this.fileAvailable = true;
    this.tileClock = 0;
    this.nextPageId = 1;
    this.pageGeneration = 0;
    this.dataKey = 0;
    this.subscriptions = new CompositeDisposable();
    this.client = new BrowseClient(props.model.getPath());
    etch.initialize(this);
    this.didMount();
  }

  didMount() {
    this.subscriptions.add(
      this.client.onDidChangeDatabase((change) => this.handleDatabaseChange(change)),
      this.client.onDidFail((error) => this.handleClientFailure(error)),
      lumine.workspace.onDidChangeActivePaneItem((item) => this.handleActiveItem(item)),
      new Disposable(() => clearTimeout(this.suspendTimer)),
    );
    const schemaCommand = (callback) => (event) => {
      event.stopPropagation();
      callback();
    };
    this.subscriptions.add(
      lumine.commands.add(this.refs.sidebar, {
        "core:move-up": schemaCommand(() => this.moveSchema(-1)),
        "core:move-down": schemaCommand(() => this.moveSchema(1)),
        "core:move-left": schemaCommand(() => this.schemaLeft()),
        "core:move-right": schemaCommand(() => this.schemaRight()),
        "core:confirm": schemaCommand(() => this.confirmSchema()),
      }),
    );
    this.loadCatalog();
  }

  update(props) {
    this.props = props;
    return etch.update(this);
  }

  schemaItems() {
    return Array.from(this.refs.sidebar?.querySelectorAll?.('[role="treeitem"]') || []).filter(
      (item) => item.offsetParent !== null,
    );
  }

  moveSchema(delta) {
    const items = this.schemaItems();
    if (!items.length) return;
    const index = items.indexOf(document.activeElement);
    items[
      Math.min(
        items.length - 1,
        Math.max(0, index < 0 ? (delta > 0 ? 0 : items.length - 1) : index + delta),
      )
    ]?.focus();
  }

  schemaLeft() {
    const active = document.activeElement;
    const group = active?.dataset?.group;
    if (group) {
      if (!this.collapsedGroups.has(group)) {
        this.collapsedGroups.add(group);
        this.patch();
      }
      return;
    }
    const object = active?.dataset?.object;
    if (!object) return;
    const groupElement = active.closest(".sqlite-view-object-group")?.querySelector("[data-group]");
    groupElement?.focus();
  }

  schemaRight() {
    const active = document.activeElement;
    const group = active?.dataset?.group;
    if (group) {
      if (this.collapsedGroups.delete(group)) {
        this.patch();
      } else {
        active.closest(".sqlite-view-object-group")?.querySelector("[data-object]")?.focus();
      }
      return;
    }
    if (active?.dataset?.object) this.selectObject(active.dataset.object);
  }

  confirmSchema() {
    const active = document.activeElement;
    if (active?.dataset?.object) this.selectObject(active.dataset.object);
    else if (active?.dataset?.group) {
      if (this.collapsedGroups.has(active.dataset.group)) this.schemaRight();
      else this.schemaLeft();
    }
  }

  async patch() {
    if (this.destroyed) return;
    await etch.update(this);
  }

  startLoading(message, { continueExisting = false } = {}) {
    const wasLoading = this.loading;
    const continuing = continueExisting && wasLoading;
    const alreadyVisible = wasLoading && this.loadingVisible;
    if (!wasLoading) this.statusBeforeLoading = this.status;
    this.loading = true;
    this.pendingLoadingMessage = message;
    if (continuing) {
      if (this.loadingVisible) this.status = message;
      return;
    }
    clearTimeout(this.loadingIndicatorTimer);
    if (alreadyVisible) {
      this.loadingIndicatorTimer = null;
      this.loadingVisible = true;
      this.status = message;
      return;
    }
    if (wasLoading) this.status = this.statusBeforeLoading;
    this.loadingVisible = false;
    this.loadingIndicatorTimer = setTimeout(() => {
      this.loadingIndicatorTimer = null;
      if (!this.loading || this.destroyed) return;
      this.loadingVisible = true;
      this.status = this.pendingLoadingMessage;
      this.patch();
    }, this.loadingIndicatorDelay);
  }

  stopLoading() {
    clearTimeout(this.loadingIndicatorTimer);
    this.loadingIndicatorTimer = null;
    this.pendingLoadingMessage = null;
    this.loading = false;
    this.loadingVisible = false;
  }

  getDisplayState() {
    if (this.loading && !this.loadingVisible && this.transitionSnapshot) {
      return this.transitionSnapshot;
    }
    return {
      selectedName: this.selectedName,
      description: this.description,
      currentPage: this.currentPage,
      previousPage: this.previousPage,
      nextPage: this.nextPage,
      totalRows: this.totalRows,
      cellDetail: this.cellDetail,
      dataKey: this.dataKey,
    };
  }

  preserveVisibleTable() {
    if (this.loadingVisible) return;
    const display = this.getDisplayState();
    if (!display.description && !display.currentPage) return;
    this.transitionSnapshot = { ...display };
  }

  finishTableTransition() {
    this.transitionSnapshot = null;
  }

  async loadCatalog(message = "Reading schema…") {
    const generation = ++this.pageGeneration;
    this.startLoading(message);
    this.error = null;
    await this.patch();
    try {
      const catalog = await this.client.request("catalog", {
        includeInternal: this.showSystem,
        includeShadow: this.showSystem,
      });
      if (generation !== this.pageGeneration) return;
      this.catalog = catalog;
      const selectable = catalog.objects.find((object) => object.name === this.selectedName);
      const firstDataObject = catalog.objects.find((object) => isDataObject(object));
      const firstObject = selectable || firstDataObject || catalog.objects[0];
      this.props.model.didChangeNavigation();
      await this.patch();
      if (firstObject) {
        await this.selectObject(firstObject.name, { continueLoading: true });
      } else {
        this.description = null;
        this.currentPage = null;
        this.previousPage = null;
        this.nextPage = null;
        this.totalRows = null;
        this.dataKey += 1;
        this.finishTableTransition();
        this.stopLoading();
        this.status = "No schema objects";
        await this.patch();
      }
    } catch (error) {
      if (generation !== this.pageGeneration) return;
      this.setError(error);
    }
  }

  async selectObject(name, { continueLoading = false } = {}) {
    const object = this.catalog?.objects.find((entry) => entry.name === name);
    if (!object) return;
    this.preserveVisibleTable();
    const generation = ++this.pageGeneration;
    this.selectedName = name;
    this.description = null;
    this.currentPage = null;
    this.previousPage = null;
    this.nextPage = null;
    this.totalRows = null;
    this.cellDetail = null;
    this.error = null;
    this.startLoading(`Loading ${name}…`, { continueExisting: continueLoading });
    this.dataKey += 1;
    this.props.model.didChangeNavigation();
    await this.patch();
    if (!isDataObject(object)) {
      this.mode = "structure";
      this.description = object;
      this.finishTableTransition();
      this.stopLoading();
      this.status = object.type;
      await this.patch();
      return;
    }
    try {
      const description = await this.client.request("describe", { name });
      if (generation !== this.pageGeneration) return;
      this.description = description;
      await this.loadFirstPage(generation, { continueLoading: true });
    } catch (error) {
      if (generation === this.pageGeneration) this.setError(error);
    }
  }

  async fetchPageTile(direction, cursor, tileIndex, totalRows = this.totalRows, requestOptions) {
    const columns = this.description?.columns || [];
    const start = tileIndex * COLUMN_TILE;
    const tile = columns.slice(start, start + COLUMN_TILE);
    if (!tile.length) return null;
    return this.client.request(
      "page",
      {
        source: { schema: "main", name: this.selectedName },
        columnIds: tile.map((column) => column.id),
        sort: this.sort,
        filters: this.filters,
        direction,
        cursor,
        ...(direction === "last" ? { totalRows } : {}),
        rowLimit: PAGE_ROWS,
      },
      requestOptions,
    );
  }

  async requestPage(
    direction,
    cursor,
    generation = this.pageGeneration,
    totalRows = this.totalRows,
  ) {
    const tileIndex = Math.floor((this.visibleColumns?.start || 0) / COLUMN_TILE);
    const result = await this.fetchPageTile(direction, cursor, tileIndex, totalRows);
    if (!result || generation !== this.pageGeneration) return null;
    const columnCount = this.description?.columns?.length || 0;
    const page = {
      ...result,
      columns: this.description.columns,
      rows: result.rows.map((row) => ({
        rowKey: row.rowKey,
        cells: Array(columnCount).fill(LOADING_CELL),
      })),
      request: { direction, cursor, totalRows },
      loadedTiles: new Map(),
      pendingTiles: new Map(),
      cacheId: this.nextPageId++,
    };
    this.applyPageTile(page, result, tileIndex);
    return page;
  }

  applyPageTile(page, result, tileIndex) {
    if (result.rows.length < page.rows.length) {
      page.rows.length = result.rows.length;
      for (const key of [
        "before",
        "after",
        "hasPrevious",
        "hasNext",
        "pagination",
        "stable",
        "degraded",
      ]) {
        page[key] = result[key];
      }
    }
    const start = tileIndex * COLUMN_TILE;
    for (let rowIndex = 0; rowIndex < page.rows.length; rowIndex++) {
      const target = page.rows[rowIndex];
      const source = result.rows[rowIndex];
      if (!source) continue;
      target.rowKey = source.rowKey;
      for (let column = 0; column < source.cells.length; column++) {
        target.cells[start + column] = source.cells[column];
      }
    }
    page.limitedByBytes ||= result.limitedByBytes;
    page.degraded ||= result.degraded;
    page.stable &&= result.stable;
    page.planFlags = {
      scan: page.planFlags?.scan || result.planFlags?.scan,
      tempSort: page.planFlags?.tempSort || result.planFlags?.tempSort,
      indexed: page.planFlags?.indexed || result.planFlags?.indexed,
    };
    page.loadedTiles.set(tileIndex, ++this.tileClock);
  }

  async ensurePageTile(page, tileIndex, generation = this.pageGeneration, replaceKey = null) {
    if (!page || page.loadedTiles.has(tileIndex)) {
      if (page) {
        page.loadedTiles.set(tileIndex, ++this.tileClock);
        if (replaceKey) this.client.cancelQueued(replaceKey);
      }
      return;
    }
    if (page.pendingTiles.has(tileIndex)) return page.pendingTiles.get(tileIndex).promise;
    const entry = { promise: null, replaceKey };
    const pending = this.fetchPageTile(
      page.request.direction,
      page.request.cursor,
      tileIndex,
      page.request.totalRows,
      { replaceKey },
    )
      .then((result) => {
        if (!result || generation !== this.pageGeneration) return;
        this.applyPageTile(page, result, tileIndex);
        this.trimPageTiles(page, new Set(this.visibleTileIndexes()));
        this.dataKey += 1;
        return this.patch();
      })
      .catch((error) => {
        if (generation === this.pageGeneration && error.code !== "SUPERSEDED") {
          this.setError(error);
        }
        throw error;
      })
      .finally(() => {
        if (page.pendingTiles.get(tileIndex) === entry) page.pendingTiles.delete(tileIndex);
      });
    entry.promise = pending;
    page.pendingTiles.set(tileIndex, entry);
    return pending;
  }

  visibleTileIndexes(range = this.visibleColumns) {
    const count = this.description?.columns?.length || 0;
    if (!count) return [];
    const start = Math.max(0, Math.min(count - 1, range?.start || 0));
    const end = Math.max(start + 1, Math.min(count, range?.end || Math.min(COLUMN_TILE, count)));
    const result = [];
    for (
      let tile = Math.floor(start / COLUMN_TILE);
      tile <= Math.floor((end - 1) / COLUMN_TILE);
      tile++
    ) {
      result.push(tile);
    }
    return result.slice(0, MAX_PAGE_COLUMN_TILES);
  }

  trimPageTiles(page, keep) {
    while (page.loadedTiles.size > MAX_PAGE_COLUMN_TILES) {
      const candidates = [...page.loadedTiles].filter(([tile]) => !keep.has(tile));
      const [tile] = (candidates.length ? candidates : [...page.loadedTiles]).sort(
        (left, right) => left[1] - right[1],
      )[0];
      page.loadedTiles.delete(tile);
      const start = tile * COLUMN_TILE;
      const end = Math.min(start + COLUMN_TILE, this.description.columns.length);
      for (const row of page.rows) row.cells.fill(LOADING_CELL, start, end);
    }
  }

  handleVisibleColumns(range) {
    this.visibleColumns = range;
    const generation = this.pageGeneration;
    const pages = [this.previousPage, this.currentPage, this.nextPage].filter(Boolean);
    for (const page of pages) {
      const tiles = this.visibleTileIndexes(range);
      const desired = new Map(
        tiles.map((tile, index) => [tile, `visible:${page.cacheId}:${index}`]),
      );
      for (const [tile, entry] of page.pendingTiles) {
        const desiredKey = desired.get(tile);
        if (entry.replaceKey && entry.replaceKey !== desiredKey) {
          if (this.client.cancelQueued(entry.replaceKey)) page.pendingTiles.delete(tile);
        }
      }
      for (let index = tiles.length; index < MAX_PAGE_COLUMN_TILES; index++) {
        this.client.cancelQueued(`visible:${page.cacheId}:${index}`);
      }
      for (let index = 0; index < tiles.length; index++) {
        this.ensurePageTile(
          page,
          tiles[index],
          generation,
          `visible:${page.cacheId}:${index}`,
        ).catch(() => {});
      }
    }
  }

  async resolveGridCell({ absoluteRow, columnIndex, value }) {
    if (value?.[0] !== "loading") return value;
    const pages = [this.previousPage, this.currentPage, this.nextPage].filter(Boolean);
    const page = pages.find((candidate) => {
      const start = Number(candidate.before?.offset || 0);
      return absoluteRow >= start && absoluteRow < start + candidate.rows.length;
    });
    if (!page) throw new Error("The selected row is outside the loaded SQLite window.");
    await this.ensurePageTile(page, Math.floor(columnIndex / COLUMN_TILE));
    const localRow = absoluteRow - Number(page.before?.offset || 0);
    return page.rows[localRow]?.cells[columnIndex] ?? null;
  }

  async loadFirstPage(generation = ++this.pageGeneration, { continueLoading = false } = {}) {
    this.startLoading("Loading rows…", { continueExisting: continueLoading });
    await this.patch();
    try {
      const page = await this.requestPage("first", null, generation);
      if (!page || generation !== this.pageGeneration) return;
      this.currentPage = page;
      this.previousPage = null;
      this.nextPage = null;
      this.finishTableTransition();
      this.stopLoading();
      this.dataKey += 1;
      this.updatePageStatus();
      await this.patch();
      this.prefetchNext(generation);
    } catch (error) {
      if (generation === this.pageGeneration) this.setError(error);
    }
  }

  async prefetchNext(generation = this.pageGeneration) {
    if (!this.currentPage?.hasNext || this.nextPage || this.destroyed) return;
    try {
      const page = await this.requestPage("next", this.currentPage.after, generation);
      if (page && generation === this.pageGeneration) {
        this.nextPage = page;
        this.dataKey += 1;
        this.patch();
      }
    } catch {
      // Prefetch is opportunistic. A foreground navigation reports its own error.
    }
  }

  async prefetchPrevious(generation = this.pageGeneration) {
    if (!this.currentPage?.hasPrevious || this.previousPage || this.destroyed) return;
    try {
      const page = await this.requestPage("previous", this.currentPage.before, generation);
      if (page && generation === this.pageGeneration) {
        this.previousPage = page;
        this.dataKey += 1;
        this.patch();
      }
    } catch {
      // Prefetch is opportunistic. A foreground navigation reports its own error.
    }
  }

  async next() {
    if (!this.currentPage?.hasNext || this.loading) return;
    const generation = this.pageGeneration;
    this.startLoading("Loading rows…");
    await this.patch();
    try {
      const next =
        this.nextPage || (await this.requestPage("next", this.currentPage.after, generation));
      if (!next || generation !== this.pageGeneration) return;
      this.previousPage = this.currentPage;
      this.currentPage = next;
      this.nextPage = null;
      this.stopLoading();
      this.dataKey += 1;
      this.updatePageStatus();
      await this.patch();
      this.prefetchNext(generation);
    } catch (error) {
      if (generation === this.pageGeneration) this.setError(error);
    }
  }

  async previous() {
    if (!this.currentPage?.hasPrevious || this.loading) return;
    const generation = this.pageGeneration;
    this.startLoading("Loading rows…");
    await this.patch();
    try {
      const previous =
        this.previousPage ||
        (await this.requestPage("previous", this.currentPage.before, generation));
      if (!previous || generation !== this.pageGeneration) return;
      this.nextPage = this.currentPage;
      this.currentPage = previous;
      this.previousPage = null;
      this.stopLoading();
      this.dataKey += 1;
      this.updatePageStatus();
      await this.patch();
      this.prefetchPrevious(generation);
    } catch (error) {
      if (generation === this.pageGeneration) this.setError(error);
    }
  }

  updatePageStatus() {
    const page = this.currentPage;
    if (!page) return;
    const start = BigInt(page.before?.offset || 0) + 1n;
    const end = start + BigInt(Math.max(0, page.rows.length - 1));
    const warnings = [];
    if (!page.stable) warnings.push("unstable offset pagination");
    if (page.degraded) warnings.push("degraded cursor");
    if (page.planFlags?.scan) warnings.push("full scan");
    if (page.planFlags?.tempSort) warnings.push("temporary sort");
    this.status = page.rows.length
      ? `Rows ${start}–${end}${page.hasNext ? ", more" : ""}${warnings.length ? ` · ${warnings.join(" · ")}` : ""}`
      : "No rows";
  }

  announceActiveRow(active) {
    const absoluteRow = active?.row;
    if (!Number.isInteger(absoluteRow) || absoluteRow < 0) return;
    const logical = BigInt(absoluteRow) + 1n;
    this.status = `Row ${logical}${this.totalRows == null ? "" : ` of ${this.totalRows}`}`;
    this.patch();
  }

  async applyFilter() {
    if (this.loading) return;
    const columnId = Number(this.refs.filterColumn?.value);
    const op = this.refs.filterOperator?.value;
    if (!Number.isInteger(columnId) || !op || this.filters.length >= 8) return;
    const filter = { columnId, op };
    if (op !== "is-null" && op !== "not-null")
      filter.value = scalarFromInput(this.refs.filterValue?.value || "");
    this.filters = [...this.filters, filter];
    await this.loadFirstPage(++this.pageGeneration);
  }

  async removeFilter(index) {
    if (this.loading) return;
    this.filters = this.filters.filter((_, current) => current !== index);
    await this.loadFirstPage(++this.pageGeneration);
  }

  async changeSort(columnId, direction) {
    if (this.loading) return;
    const id = Number(columnId);
    this.sort =
      columnId !== "" && Number.isInteger(id) && direction && direction !== "none"
        ? { columnId: id, direction }
        : null;
    await this.loadFirstPage(++this.pageGeneration);
  }

  async cycleSort(column) {
    const id = column?.id ?? column?.key;
    const current = this.sort?.columnId === id ? this.sort.direction : null;
    const direction = current === null ? "asc" : current === "asc" ? "desc" : null;
    await this.changeSort(id, direction);
  }

  async countRows() {
    if (!this.description || this.counting || this.loading) return;
    this.error = null;
    this.counting = true;
    this.status = "Counting rows…";
    await this.patch();
    try {
      const result = await this.client.runCount({
        source: { schema: "main", name: this.selectedName },
        filters: this.filters,
      });
      this.totalRows = result.count;
      const generation = ++this.pageGeneration;
      const last = await this.requestPage("last", null, generation, result.count);
      if (generation !== this.pageGeneration) return;
      this.currentPage = last;
      this.previousPage = null;
      this.nextPage = null;
      this.dataKey += 1;
      this.updatePageStatus();
      this.prefetchPrevious(generation);
    } catch (error) {
      if (error.code === "CANCELLED") this.status = "Count cancelled.";
      else this.setError(error);
    } finally {
      this.counting = false;
      await this.patch();
    }
  }

  setMode(mode) {
    this.mode = mode;
    this.patch().then(() => {
      if (mode === "query") this.focusQuery();
      else if (mode === "data") this.focusGrid();
    });
  }

  executeQuery() {
    if (!this.refs.queryEditor) {
      this.mode = "query";
      this.patch().then(() => this.executeQuery());
      return;
    }
    if (this.mode !== "query") {
      this.mode = "query";
      this.patch();
    }
    const sql = this.refs.queryEditor.getStatementSource().trim();
    if (!sql) {
      this.status = "Select a query or place the cursor inside one.";
      this.patch();
      return;
    }
    const statusBeforeQuery = this.status;
    this.cancelQuery();
    this.error = null;
    this.queryError = null;
    this.statusBeforeQuery = statusBeforeQuery;
    if (this.history[0] !== sql) this.history = [sql, ...this.history].slice(0, HISTORY_LIMIT);
    this.queryColumns = [];
    this.queryRows = [];
    this.queryRunning = true;
    this.queryStale = false;
    this.queryStartedAt = Date.now();
    this.dataKey += 1;
    this.status = "Running query…";
    this.patch();
    this.client.runQuery(sql, (event) => this.handleQueryEvent(event));
  }

  handleQueryEvent(event) {
    if (!event || this.destroyed) return;
    if (event.type === "start") {
      this.queryError = null;
      this.queryColumns = event.columns || [];
    } else if (event.type === "chunk") {
      this.queryRows.push(...(event.rows || []));
      this.status = `${this.queryRows.length} query rows…`;
    } else if (event.type === "done") {
      this.queryRunning = false;
      this.queryStale = Boolean(event.databaseChangedDuringRun);
      const suffix = event.truncated ? ` · truncated by ${event.truncated}` : "";
      this.status = `${event.rows ?? this.queryRows.length} rows · ${event.elapsedMs ?? Date.now() - this.queryStartedAt} ms${suffix}${this.queryStale ? " · database changed" : ""}`;
      this.statusBeforeQuery = null;
    } else if (event.type === "error") {
      this.queryRunning = false;
      if (event.error?.code === "CANCELLED") {
        this.queryError = null;
        this.status = "Query cancelled.";
      } else {
        const error = event.error || event;
        this.queryError = {
          code: error?.code || "SQLITE_ERROR",
          message: error?.message || String(error),
        };
        this.status = this.statusBeforeQuery || "";
      }
      this.statusBeforeQuery = null;
    }
    this.dataKey += 1;
    this.patch();
  }

  cancelQuery() {
    const queryCancelled = this.client.cancelQuery();
    const countCancelled = this.client.cancelCount();
    if (!queryCancelled && !countCancelled) return;
    this.queryRunning = false;
    this.counting = false;
    if (queryCancelled) {
      this.queryError = null;
      this.statusBeforeQuery = null;
    }
    this.status = "Operation cancelled.";
    this.patch();
  }

  restoreHistory(event) {
    const value = event.target.value;
    if (!value) return;
    this.queryText = value;
    this.patch().then(() => this.focusQuery());
    event.target.value = "";
  }

  async showCell({ columnDefinition, record }) {
    if (!record?.rowKey || !this.description || this.loading) return;
    try {
      this.cellDetail = await this.client.request("cell", {
        source: { schema: "main", name: this.selectedName },
        rowKey: record.rowKey,
        columnId: columnDefinition.key,
      });
      await this.patch();
    } catch (error) {
      this.setError(error);
    }
  }

  async refresh() {
    this.pageGeneration += 1;
    if (this.queryRows.length) this.queryStale = true;
    this.client.restart(this.props.model.getPath());
    await this.loadCatalog();
  }

  handleDatabaseChange(change) {
    this.queryStale = this.queryRows.length > 0;
    this.loadCatalog(
      change.schemaChanged ? "Schema changed; refreshing…" : "Database changed; refreshing…",
    );
  }

  handleClientFailure(error) {
    if (error.code === "FILE_REPLACED") {
      if (this.queryRows.length) this.queryStale = true;
      this.client.restart(this.props.model.getPath());
      this.loadCatalog("Database replaced; refreshing…");
    } else if (error.code === "FILE_DELETED" || error.code === "FILE_NOT_FOUND") {
      this.handleFileDeleted();
    } else {
      this.setError(error);
    }
  }

  handleExternalChange() {
    this.client.request("check-version").catch((error) => {
      if (!["STALE_REVISION", "RESTARTED"].includes(error.code)) this.setError(error);
    });
  }

  handleFileDeleted() {
    if (this.queryRows.length) this.queryStale = true;
    this.fileAvailable = false;
    this.client.suspend();
    this.finishTableTransition();
    this.stopLoading();
    this.error = {
      code: "FILE_DELETED",
      message: "The database file was deleted. Waiting for it to reappear.",
    };
    this.status = "Database file missing";
    this.patch();
  }

  handleFileAvailable() {
    this.fileAvailable = true;
    this.error = null;
    this.client.restart(this.props.model.getPath());
    this.loadCatalog();
  }

  handleFileRenamed(newPath) {
    this.fileAvailable = true;
    this.client.restart(newPath);
    this.loadCatalog();
  }

  handleActiveItem(item) {
    clearTimeout(this.suspendTimer);
    if (item === this.props.model) {
      if (!this.fileAvailable) return;
      if (this.client.resume()) this.loadCatalog();
      return;
    }
    this.suspendTimer = setTimeout(() => this.client.suspend(), 30_000);
  }

  setError(error) {
    if (!this.fileAvailable && ["SUSPENDED", "RESTARTED", "DESTROYED"].includes(error?.code)) {
      return;
    }
    this.finishTableTransition();
    this.stopLoading();
    this.error = { code: error?.code || "SQLITE_ERROR", message: error?.message || String(error) };
    this.status = this.error.message;
    this.patch();
  }

  getSerializableState() {
    const widths = this.refs.dataGrid?.grid?.columnWidths;
    if (Array.isArray(widths) && this.description?.columns) {
      this.columnWidths = {
        ...this.columnWidths,
        [this.selectedName]: Object.fromEntries(
          this.description.columns.map((column, index) => [column.id, widths[index]]),
        ),
      };
    }
    return {
      selectedObject: this.selectedName,
      mode: this.mode,
      queryText: this.queryText,
      sort: this.sort,
      filters: this.filters,
      columnWidths: this.columnWidths,
      sidebarWidth: this.sidebarWidth,
      queryEditorHeight: this.queryEditorHeight,
      showSystem: this.showSystem,
    };
  }

  getNavigationHeaders() {
    const display = this.getDisplayState();
    const groups = groupObjects(this.catalog?.objects || []);
    return groups.map(([label, objects]) => ({
      text: label,
      level: 1,
      children: objects.map((object) => ({
        text: object.name,
        level: 2,
        children:
          object.name === display.selectedName
            ? (display.description?.columns || []).map((column) => ({
                text: column.name,
                level: 3,
                children: [],
                sqliteObject: object.name,
                sqliteColumn: column.id,
              }))
            : [],
        currentCount: object.name === display.selectedName ? 1 : 0,
        stackCount: object.name === display.selectedName ? 1 : 0,
        sqliteObject: object.name,
      })),
    }));
  }

  navigateTo(header, options = {}) {
    if (!header?.sqliteObject) return;
    Promise.resolve(this.selectObject(header.sqliteObject)).then(() => {
      const columnIndex =
        header.sqliteColumn == null
          ? -1
          : this.description?.columns?.findIndex((column) => column.id === header.sqliteColumn);
      if (columnIndex >= 0) this.mode = "data";
      this.patch().then(() => {
        if (columnIndex >= 0) this.refs.dataGrid?.grid?.moveActiveSelectionTo(0, columnIndex);
        if (options.focus !== false) this.focusGrid();
      });
    });
  }

  getDefaultFocusTarget() {
    return (
      this.refs.sidebar ||
      this.refs.dataGrid?.element ||
      this.refs.queryEditor?.element ||
      this.element
    );
  }

  focusSchema() {
    this.refs.sidebar?.focus({ preventScroll: true });
  }

  focusQuery() {
    if (this.mode !== "query") {
      this.mode = "query";
      this.patch().then(() => this.refs.queryEditor?.focus());
    } else {
      this.refs.queryEditor?.focus();
    }
  }

  focusGrid() {
    if (this.mode === "structure") this.mode = "data";
    this.patch().then(() => {
      const grid = this.mode === "query" ? this.refs.queryGrid : this.refs.dataGrid;
      grid?.focus();
    });
  }

  startSidebarResize(event) {
    if (event.button !== 0) return;
    this.resizingSidebar = true;
    window.addEventListener("mousemove", this.resizeSidebar);
    window.addEventListener("mouseup", this.stopSidebarResize);
    event.preventDefault();
  }

  resizeSidebar = (event) => {
    if (!this.resizingSidebar || !this.refs.layout) return;
    const rect = this.refs.layout.getBoundingClientRect();
    this.setSidebarWidth(event.clientX - rect.left, false);
  };

  stopSidebarResize = () => {
    if (!this.resizingSidebar) return;
    this.resizingSidebar = false;
    window.removeEventListener("mousemove", this.resizeSidebar);
    window.removeEventListener("mouseup", this.stopSidebarResize);
    this.patch();
  };

  setSidebarWidth(width, update = true) {
    const maximum = Math.max(180, Math.min(600, (this.refs.layout?.clientWidth || 1200) / 2));
    this.sidebarWidth = Math.round(Math.min(maximum, Math.max(180, width)));
    this.refs.layout?.style.setProperty("--sqlite-view-sidebar-width", `${this.sidebarWidth}px`);
    this.refs.sidebarResizer?.setAttribute("aria-valuenow", String(this.sidebarWidth));
    if (update) this.patch();
  }

  resizeSidebarWithKeyboard(event) {
    if (!["ArrowLeft", "ArrowRight"].includes(event.key)) return;
    this.setSidebarWidth(this.sidebarWidth + (event.key === "ArrowLeft" ? -16 : 16));
    event.preventDefault();
  }

  startQueryResize(event) {
    if (event.button !== 0) return;
    this.resizingQuery = true;
    window.addEventListener("mousemove", this.resizeQuery);
    window.addEventListener("mouseup", this.stopQueryResize);
    event.preventDefault();
  }

  resizeQuery = (event) => {
    if (!this.resizingQuery || !this.refs.queryEditor) return;
    const top = this.refs.queryEditor.element.getBoundingClientRect().top;
    this.setQueryEditorHeight(event.clientY - top, false);
  };

  stopQueryResize = () => {
    if (!this.resizingQuery) return;
    this.resizingQuery = false;
    window.removeEventListener("mousemove", this.resizeQuery);
    window.removeEventListener("mouseup", this.stopQueryResize);
    this.patch();
  };

  setQueryEditorHeight(height, update = true) {
    const maximum = Math.max(96, (this.refs.queryPanel?.clientHeight || 500) - 160);
    this.queryEditorHeight = Math.round(Math.min(maximum, Math.max(96, height)));
    this.refs.queryPanel?.style.setProperty(
      "--sqlite-view-query-editor-height",
      `${this.queryEditorHeight}px`,
    );
    this.refs.queryResizer?.setAttribute("aria-valuenow", String(this.queryEditorHeight));
    if (update) this.patch();
  }

  resizeQueryWithKeyboard(event) {
    if (!["ArrowUp", "ArrowDown"].includes(event.key)) return;
    this.setQueryEditorHeight(this.queryEditorHeight + (event.key === "ArrowUp" ? -16 : 16));
    event.preventDefault();
  }

  renderSidebar() {
    const groups = groupObjects(this.catalog?.objects || []);
    return (
      <aside className="sqlite-view-sidebar">
        <div className="sqlite-view-sidebar-header">
          <strong>Schema</strong>
          <label title="Show SQLite system and shadow objects">
            <input
              type="checkbox"
              checked={this.showSystem}
              onChange={(event) => {
                this.showSystem = event.target.checked;
                this.loadCatalog();
              }}
            />
            System
          </label>
        </div>
        <div className="sqlite-view-object-list" role="tree" tabIndex="0" ref="sidebar">
          {groups.map(([label, objects]) => (
            <div className="sqlite-view-object-group" role="group">
              <div
                className="sqlite-view-object-group-title"
                role="treeitem"
                tabIndex="-1"
                data-group={label}
                aria-expanded={this.collapsedGroups.has(label) ? "false" : "true"}
              >
                {label}
              </div>
              {this.collapsedGroups.has(label)
                ? null
                : objects.map((object) => (
                    <button
                      type="button"
                      className={`sqlite-view-object ${object.name === this.selectedName ? "selected" : ""}`}
                      role="treeitem"
                      tabIndex="-1"
                      data-object={object.name}
                      aria-selected={object.name === this.selectedName ? "true" : "false"}
                      onClick={() => this.selectObject(object.name)}
                    >
                      <span>{object.name}</span>
                      {object.estimatedRows ? <small>≈{object.estimatedRows}</small> : null}
                    </button>
                  ))}
            </div>
          ))}
        </div>
      </aside>
    );
  }

  renderToolbar() {
    return (
      <header className="sqlite-view-toolbar">
        <div className="btn-group">
          {[
            ["data", "Data"],
            ["structure", "Structure"],
            ["query", "Query"],
          ].map(([id, label]) => (
            <button
              type="button"
              className={`btn ${this.mode === id ? "selected" : ""}`}
              onClick={() => this.setMode(id)}
            >
              {label}
            </button>
          ))}
        </div>
        <span className="sqlite-view-current-object">
          {this.selectedName || "No object selected"}
        </span>
        <button
          type="button"
          className="btn icon icon-sync"
          title="Refresh"
          onClick={() => this.refresh()}
        >
          Refresh
        </button>
      </header>
    );
  }

  renderData() {
    const display = this.getDisplayState();
    const columns = display.description?.columns || [];
    const page = display.currentPage;
    const pages = [display.previousPage, page, display.nextPage].filter(Boolean);
    const rows = pages.flatMap((entry) =>
      entry.rows.map((row) => attachRowKey(row.cells, row.rowKey)),
    );
    const firstPage = pages[0];
    const lastPage = pages.at(-1);
    return (
      <section className={`sqlite-view-data ${this.mode === "data" ? "" : "is-hidden"}`}>
        <div className="sqlite-view-data-controls">
          <select
            ref="sortColumn"
            aria-label="Sort column"
            value={this.sort?.columnId ?? ""}
            onChange={(event) => this.changeSort(event.target.value, this.refs.sortDirection.value)}
          >
            <option value="">Sort column…</option>
            {columns.map((column) => (
              <option value={column.id}>{column.name}</option>
            ))}
          </select>
          <select
            ref="sortDirection"
            aria-label="Sort direction"
            value={this.sort?.direction || "none"}
            onChange={(event) => this.changeSort(this.refs.sortColumn.value, event.target.value)}
          >
            <option value="none">Unsorted</option>
            <option value="asc">Ascending</option>
            <option value="desc">Descending</option>
          </select>
          <select ref="filterColumn" aria-label="Filter column">
            <option value="">Filter column…</option>
            {columns.map((column) => (
              <option value={column.id}>{column.name}</option>
            ))}
          </select>
          <select ref="filterOperator" aria-label="Filter operator">
            {[
              ["eq", "="],
              ["ne", "≠"],
              ["lt", "<"],
              ["lte", "≤"],
              ["gt", ">"],
              ["gte", "≥"],
              ["is-null", "is NULL"],
              ["not-null", "not NULL"],
              ["contains", "contains"],
              ["starts-with", "starts with"],
            ].map(([value, label]) => (
              <option value={value}>{label}</option>
            ))}
          </select>
          <input
            ref="filterValue"
            type="text"
            placeholder="Value"
            aria-label="Filter value"
            onKeyDown={(event) => event.key === "Enter" && this.applyFilter()}
          />
          <button
            type="button"
            className="btn"
            onClick={() => this.applyFilter()}
            disabled={this.filters.length >= 8}
          >
            Apply
          </button>
          <button
            type="button"
            className="btn"
            onClick={() => this.countRows()}
            disabled={this.counting}
          >
            Count
          </button>
          {this.counting ? (
            <button type="button" className="btn" onClick={() => this.cancelQuery()}>
              Stop
            </button>
          ) : null}
        </div>
        {this.filters.length ? (
          <div className="sqlite-view-filters">
            {this.filters.map((filter, index) => (
              <button
                type="button"
                className="sqlite-view-filter"
                onClick={() => this.removeFilter(index)}
                title="Remove filter"
              >
                {columnName(columns, filter.columnId)} {filter.op}{" "}
                {filter.value ? formatScalar(filter.value) : ""} ×
              </button>
            ))}
          </div>
        ) : null}
        <GridHost
          ref="dataGrid"
          dataKey={`data:${display.dataKey}`}
          columns={gridColumns(columns, this.columnWidths[display.selectedName] || {})}
          rows={rows}
          baseRow={Number(firstPage?.before?.offset || 0)}
          totalRows={display.totalRows == null ? null : Number(display.totalRows)}
          hasPrevious={Boolean(firstPage?.hasPrevious)}
          hasNext={Boolean(lastPage?.hasNext)}
          ariaLabel={`Rows from ${display.selectedName || "SQLite object"}`}
          loading={this.loading}
          onNeedPrevious={() => this.previous()}
          onNeedNext={() => this.next()}
          onRequestEnd={() => this.countRows()}
          onSort={(column) => this.cycleSort(column)}
          onConfirm={(cell) => this.showCell(cell)}
          onError={(error) => this.setError(error)}
          onSelectionChange={(_selections, active) => this.announceActiveRow(active)}
          onVisibleColumnsChange={(range) => this.handleVisibleColumns(range)}
          resolveCell={(context) => this.resolveGridCell(context)}
        />
        <div className="sqlite-view-pager">
          <button
            type="button"
            className="btn"
            disabled={!page?.hasPrevious || this.loading}
            onClick={() => this.previous()}
          >
            Previous
          </button>
          <button
            type="button"
            className="btn"
            disabled={!page?.hasNext || this.loading}
            onClick={() => this.next()}
          >
            Next
          </button>
        </div>
        {display.cellDetail ? (
          <pre className="sqlite-view-cell-detail">{formatDetail(display.cellDetail)}</pre>
        ) : null}
      </section>
    );
  }

  renderStructure() {
    const description = this.getDisplayState().description;
    return (
      <section className={`sqlite-view-structure ${this.mode === "structure" ? "" : "is-hidden"}`}>
        {description ? (
          <div>
            <h2>{description.name}</h2>
            <dl>
              <dt>Type</dt>
              <dd>{description.type}</dd>
              <dt>Rows</dt>
              <dd>{description.estimatedRows ? `≈${description.estimatedRows}` : "Unknown"}</dd>
              <dt>Identity</dt>
              <dd>{description.identity?.mode || "n/a"}</dd>
            </dl>
            {description.columns?.length ? (
              <table>
                <thead>
                  <tr>
                    <th>Name</th>
                    <th>Type</th>
                    <th>PK</th>
                    <th>Nullable</th>
                    <th>Default</th>
                    <th>Storage</th>
                  </tr>
                </thead>
                <tbody>
                  {description.columns.map((column) => (
                    <tr>
                      <td>{column.name}</td>
                      <td>{column.declaredType || "—"}</td>
                      <td>{column.primaryKey || ""}</td>
                      <td>{column.notNull ? "No" : "Yes"}</td>
                      <td>{column.defaultSql ?? ""}</td>
                      <td>{column.hidden}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            ) : null}
            {description.indexes?.length ? <h3>Indexes</h3> : null}
            {(description.indexes || []).map((index) => (
              <pre>{index.sql || index.name}</pre>
            ))}
            {description.foreignKeys?.length ? <h3>Foreign keys</h3> : null}
            {(description.foreignKeys || []).map((key) => (
              <div>
                {key.from} → {key.table}.{key.to}
              </div>
            ))}
            {description.sql ? (
              <pre className="sqlite-view-ddl">
                {description.sql}
                {description.sqlTruncated ? "\n…" : ""}
              </pre>
            ) : null}
          </div>
        ) : (
          <p>Select a schema object.</p>
        )}
      </section>
    );
  }

  renderQuery() {
    return (
      <section
        className={`sqlite-view-query ${this.mode === "query" ? "" : "is-hidden"}`}
        ref="queryPanel"
        style={{ "--sqlite-view-query-editor-height": `${this.queryEditorHeight}px` }}
      >
        <div className="sqlite-view-query-actions">
          <button
            type="button"
            className="btn btn-primary icon icon-playback-play"
            onClick={() => this.executeQuery()}
            disabled={this.queryRunning}
          >
            Run
          </button>
          <button
            type="button"
            className="btn icon icon-primitive-square"
            onClick={() => this.cancelQuery()}
            disabled={!this.queryRunning && !this.counting}
          >
            Stop
          </button>
          <select
            aria-label="Session query history"
            onChange={(event) => this.restoreHistory(event)}
          >
            <option value="">History…</option>
            {this.history.map((sql) => (
              <option value={sql}>{oneLine(sql)}</option>
            ))}
          </select>
          {this.queryError ? (
            <span
              className="sqlite-view-query-error"
              role="alert"
              title={`${this.queryError.code}: ${this.queryError.message}`}
            >
              <strong>{this.queryError.code}</strong> {this.queryError.message}
            </span>
          ) : null}
          {this.queryStale ? <span className="text-warning">Result is stale</span> : null}
        </div>
        <QueryEditor
          ref="queryEditor"
          text={this.queryText}
          statementAt={statementAt}
          onDidChange={(text) => {
            this.queryText = text;
          }}
        />
        <div
          className="sqlite-view-query-resizer"
          ref="queryResizer"
          role="separator"
          tabIndex="0"
          aria-orientation="horizontal"
          aria-valuemin="96"
          aria-valuemax="600"
          aria-valuenow={String(this.queryEditorHeight)}
          onMouseDown={(event) => this.startQueryResize(event)}
          onKeyDown={(event) => this.resizeQueryWithKeyboard(event)}
        />
        <GridHost
          ref="queryGrid"
          dataKey={`query:${this.dataKey}`}
          columns={gridColumns(this.queryColumns)}
          rows={this.queryRows}
          bounded={true}
          baseRow={0}
          totalRows={this.queryRows.length}
          hasPrevious={false}
          hasNext={false}
          ariaLabel="SQLite query result"
          loading={this.queryRunning}
        />
      </section>
    );
  }

  render() {
    return (
      <div className="sqlite-view-shell">
        {this.renderToolbar()}
        <div
          className="sqlite-view-layout"
          ref="layout"
          style={{ "--sqlite-view-sidebar-width": `${this.sidebarWidth}px` }}
        >
          {this.renderSidebar()}
          <div
            className="sqlite-view-sidebar-resizer"
            ref="sidebarResizer"
            role="separator"
            tabIndex="0"
            aria-orientation="vertical"
            aria-valuemin="180"
            aria-valuemax="600"
            aria-valuenow={String(this.sidebarWidth)}
            onMouseDown={(event) => this.startSidebarResize(event)}
            onKeyDown={(event) => this.resizeSidebarWithKeyboard(event)}
          />
          <main className="sqlite-view-main">
            {this.error ? (
              <div className="sqlite-view-error alert alert-error">
                <strong>{this.error.code}</strong> {this.error.message}
              </div>
            ) : null}
            {this.renderData()}
            {this.renderStructure()}
            {this.renderQuery()}
          </main>
        </div>
        <footer className="sqlite-view-status" role="status" aria-live="polite">
          {this.loadingVisible || this.queryRunning || this.counting ? (
            <span className="loading loading-spinner-tiny" />
          ) : null}
          <span>{this.status}</span>
        </footer>
      </div>
    );
  }

  destroy() {
    if (this.destroyed) return;
    this.destroyed = true;
    clearTimeout(this.suspendTimer);
    this.stopLoading();
    this.stopSidebarResize();
    this.stopQueryResize();
    this.subscriptions.dispose();
    this.client.destroy();
    return etch.destroy(this);
  }
}

function isDataObject(object) {
  return ["table", "view", "virtual"].includes(object?.type);
}

function groupObjects(objects) {
  const groups = [
    ["Tables", []],
    ["Views", []],
    ["Indexes", []],
    ["Triggers", []],
  ];
  for (const object of objects) {
    if (object.type === "view") groups[1][1].push(object);
    else if (object.type === "index") groups[2][1].push(object);
    else if (object.type === "trigger") groups[3][1].push(object);
    else groups[0][1].push(object);
  }
  return groups.filter(([, values]) => values.length);
}

function scalarFromInput(value) {
  if (/^-?\d+$/.test(value)) return ["i", value];
  if (/^-?(?:\d+\.\d*|\d*\.\d+)(?:e[+-]?\d+)?$/i.test(value)) return ["r", value];
  return ["t", value];
}

function formatScalar(value) {
  if (value == null) return "NULL";
  return value[1];
}

function formatCell(value) {
  if (value == null) return "NULL";
  if (!Array.isArray(value)) return String(value);
  if (value[0] === "loading") return "Loading…";
  if (value[0] === "b") return `<BLOB ${value[1]} bytes>${value[2] ? ` ${value[2]}` : ""}`;
  if (value[0] === "t") return `${value[1]}${value[2] ? "…" : ""}`;
  return value[1];
}

function gridColumns(columns, widths = {}) {
  return columns.map((column, index) => ({
    id: column.id ?? index,
    key: column.id ?? index,
    label: column.name || column.columnName || `Column ${index + 1}`,
    name: column.name || column.columnName || `Column ${index + 1}`,
    width: Number(widths[column.id ?? index]) || 140,
    format: formatCell,
  }));
}

function attachRowKey(cells, rowKey) {
  cells.rowKey = rowKey;
  return cells;
}

function columnName(columns, id) {
  return columns.find((column) => column.id === id)?.name || `#${id}`;
}

function formatDetail(detail) {
  if (detail.type === "blob")
    return `<BLOB ${detail.byteLength} bytes>\n${detail.base64}${detail.truncated ? "\n…" : ""}`;
  return `${formatScalar(detail.value)}${detail.truncated ? "\n…" : ""}`;
}

function oneLine(sql) {
  return sql.replace(/\s+/g, " ").trim().slice(0, 100);
}

module.exports = SQLiteViewComponent;
module.exports.GridHost = GridHost;
module.exports.formatCell = formatCell;
module.exports.scalarFromInput = scalarFromInput;
