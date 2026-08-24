const fs = require("node:fs");
const path = require("node:path");
const { CompositeDisposable, Disposable } = require("lumine");
const etch = require("@lumine-code/etch");
const SQLiteView = require("./sqlite-view");

etch.setScheduler(lumine.views);

const DEFAULT_EXTENSIONS = Object.freeze([".sqlite", ".sqlite3", ".db", ".db3"]);
const ADDITIONAL_EXTENSIONS_CONFIG = "sqlite-view.additionalExtensions";
const MAGIC = Buffer.from("SQLite format 3\0", "binary");
let subscriptions = null;

function activate() {
  subscriptions = new CompositeDisposable(
    lumine.workspace.addOpener(openSQLite),
    lumine.commands.add("lumine-workspace", {
      "sqlite-view:execute-query": {
        description: "Run the selected SQL or the statement under the cursor.",
        didDispatch: (event) => dispatchToView(event, "executeQuery"),
      },
      "sqlite-view:cancel-query": {
        description: "Stop the running SQLite query.",
        didDispatch: (event) => dispatchToView(event, "cancelQuery"),
      },
      "sqlite-view:refresh": {
        description: "Refresh the selected SQLite object.",
        didDispatch: (event) => dispatchToView(event, "refresh"),
      },
      "sqlite-view:focus-schema": {
        description: "Move focus to the SQLite schema tree.",
        didDispatch: (event) => dispatchToView(event, "focusSchema"),
      },
      "sqlite-view:focus-query": {
        description: "Move focus to the SQLite query editor.",
        didDispatch: (event) => dispatchToView(event, "focusQuery"),
      },
      "sqlite-view:focus-grid": {
        description: "Move focus to the SQLite data grid.",
        didDispatch: (event) => dispatchToView(event, "focusGrid"),
      },
    }),
    new Disposable(() => destroyAllViews()),
  );
}

function deactivate() {
  subscriptions?.dispose();
  subscriptions = null;
}

function deserialize(state = {}) {
  if (!state.path && !state.filePath) return undefined;
  return new SQLiteView(state.path || state.filePath, state);
}

function openSQLite(uri = "") {
  if (!isSupportedPath(uri)) return;
  if (!hasSQLiteHeader(uri)) return;
  return new SQLiteView(uri);
}

function normalizeExtension(value) {
  if (typeof value !== "string") return null;
  let extension = value.trim().toLowerCase();
  if (extension.startsWith("*.")) extension = extension.slice(1);
  if (!extension.startsWith(".")) extension = `.${extension}`;
  if (
    !/^\.[a-z0-9][a-z0-9._+-]*$/.test(extension) ||
    extension.includes("..") ||
    extension.endsWith(".")
  ) {
    return null;
  }
  return extension;
}

function configuredExtensions() {
  const extensions = new Set(DEFAULT_EXTENSIONS);
  const additional = lumine.config.get(ADDITIONAL_EXTENSIONS_CONFIG);
  if (!Array.isArray(additional)) return extensions;
  for (const value of additional) {
    const extension = normalizeExtension(value);
    if (extension) extensions.add(extension);
  }
  return extensions;
}

function isSupportedPath(filePath) {
  if (typeof filePath !== "string" || filePath === "") return false;
  const name = path.basename(filePath).toLowerCase();
  return [...configuredExtensions()].some((extension) => name.endsWith(extension));
}

function hasSQLiteHeader(filePath) {
  let descriptor;
  try {
    descriptor = fs.openSync(filePath, "r");
    const header = Buffer.allocUnsafe(MAGIC.length);
    return (
      fs.readSync(descriptor, header, 0, header.length, 0) === header.length && header.equals(MAGIC)
    );
  } catch {
    return false;
  } finally {
    if (descriptor !== undefined) fs.closeSync(descriptor);
  }
}

function dispatchToView(event, method) {
  const targetRoot = event?.target?.closest?.(".sqlite-view");
  const targeted = targetRoot?.sqliteViewModel;
  const active = lumine.workspace.getActivePaneItem?.();
  const view =
    targeted instanceof SQLiteView ? targeted : active instanceof SQLiteView ? active : null;
  if (view) {
    view[method]?.();
    return;
  }
  if (active) {
    lumine.notifications.addWarning("SQLite View", {
      description: "Open a SQLite database first.",
    });
  }
}

function destroyAllViews() {
  for (const item of lumine.workspace.getPaneItems()) {
    if (item instanceof SQLiteView) item.destroy();
  }
}

function provideNavigationAdapter() {
  return {
    handlesItem: (item) => item instanceof SQLiteView,
    observeHeaders(item, callback) {
      const update = () => callback(item.getNavigationHeaders(), { instant: true });
      update();
      return item.onDidChangeNavigation(update);
    },
    navigateTo(item, header, options = {}) {
      item.navigateTo(header, options);
    },
  };
}

module.exports = {
  activate,
  deactivate,
  deserialize,
  provideNavigationAdapter,
  hasSQLiteHeader,
  configuredExtensions,
  isSupportedPath,
  normalizeExtension,
};
