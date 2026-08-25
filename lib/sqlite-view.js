const fs = require("node:fs");
const path = require("node:path");
const { CompositeDisposable, Disposable, Emitter, watchFile } = require("lumine");

class SQLiteView {
  constructor(filePath, state = {}) {
    this.filePath = path.resolve(filePath);
    this.state = state.viewState || state;
    this.destroyed = false;
    this.emitter = new Emitter();
    this.subscriptions = new CompositeDisposable();
    this.fileSubscriptions = new CompositeDisposable();
    this._element = document.createElement("div");
    this._element.className = "sqlite-view";
    this._element.tabIndex = -1;
    this._element.sqliteViewModel = this;
    this._element.addEventListener("focus", this.redirectFocus);
    this._element.addEventListener("focusin", this.rememberFocus);
    this.subscriptions.add(
      new Disposable(() => {
        this._element.removeEventListener("focus", this.redirectFocus);
        this._element.removeEventListener("focusin", this.rememberFocus);
      }),
    );
    if (fs.existsSync(this.filePath)) this.armFileWatcher();
    else this.handleDelete();
  }

  get element() {
    this.ensureComponent();
    return this._element;
  }

  ensureComponent() {
    if (this.component || this.destroyed) return this.component;
    const SQLiteViewComponent = require("./view");
    this.component = new SQLiteViewComponent({ model: this, state: this.state });
    this._element.appendChild(this.component.element);
    if (this.fileMissing) this.component.handleFileDeleted();
    return this.component;
  }

  armFileWatcher() {
    this.fileSubscriptions.dispose();
    this.fileSubscriptions = new CompositeDisposable();
    const file = watchFile(this.filePath);
    this.file = file;
    this.fileSubscriptions.add(new Disposable(() => file.dispose()));
    this.fileSubscriptions.add(
      file.onDidRename((newPath) => {
        if (!newPath) return this.handleDelete();
        this.filePath = newPath;
        this.emitter.emit("did-change-title");
        this.component?.handleFileRenamed(newPath);
      }),
      file.onDidDelete(() => this.handleDelete()),
      file.onDidChange(() => {
        if (fs.existsSync(this.filePath)) {
          this.component?.handleFileAvailable();
          this.component?.handleExternalChange();
        }
      }),
    );
  }

  handleDelete() {
    this.fileMissing = true;
    this.fileSubscriptions.dispose();
    this.fileSubscriptions = new CompositeDisposable();
    this.file = null;
    this.component?.handleFileDeleted();
    clearInterval(this.recoveryTimer);
    this.recoveryTimer = setInterval(() => {
      if (!fs.existsSync(this.filePath)) return;
      clearInterval(this.recoveryTimer);
      this.recoveryTimer = null;
      this.armFileWatcher();
      this.fileMissing = false;
      this.component?.handleFileAvailable();
    }, 1000);
  }

  rememberFocus = (event) => {
    if (event.target !== this._element && this._element.contains(event.target)) {
      this.lastFocused = event.target;
    }
  };

  redirectFocus = (event) => {
    if (event.target !== this._element) return;
    requestAnimationFrame(() => {
      if (document.activeElement === this._element) this.focus();
    });
  };

  focus() {
    const target =
      (this.lastFocused?.isConnected &&
        this.lastFocused.offsetParent !== null &&
        this.lastFocused) ||
      this.ensureComponent()?.getDefaultFocusTarget() ||
      this._element;
    target.focus?.({ preventScroll: true });
  }

  executeQuery() {
    this.ensureComponent()?.executeQuery();
  }

  cancelQuery() {
    this.component?.cancelQuery();
  }

  refresh() {
    this.ensureComponent()?.refresh();
  }

  focusSchema() {
    this.ensureComponent()?.focusSchema();
  }

  focusQuery() {
    this.ensureComponent()?.focusQuery();
  }

  focusGrid() {
    this.ensureComponent()?.focusGrid();
  }

  getPath() {
    return this.file?.getPath?.() || this.filePath;
  }

  getURI() {
    return this.getPath();
  }

  getTitle() {
    return path.basename(this.getPath());
  }

  getIconName() {
    return "database";
  }

  getDefaultLocation() {
    return "center";
  }

  getAllowedLocations() {
    return ["center"];
  }

  isEqual(other) {
    return other instanceof SQLiteView && other.getURI() === this.getURI();
  }

  copy() {
    return new SQLiteView(this.getPath(), this.serialize());
  }

  serialize() {
    return {
      deserializer: "SQLiteView",
      path: this.getPath(),
      viewState: this.component?.getSerializableState() || this.state || {},
    };
  }

  onDidChangeTitle(callback) {
    return this.emitter.on("did-change-title", callback);
  }

  onDidDestroy(callback) {
    return this.emitter.on("did-destroy", callback);
  }

  destroy() {
    if (this.destroyed) return;
    this.destroyed = true;
    clearInterval(this.recoveryTimer);
    this.component?.destroy();
    this.component = null;
    this.fileSubscriptions.dispose();
    this.subscriptions.dispose();
    this._element.remove();
    this.emitter.emit("did-destroy");
    this.emitter.dispose();
  }
}

module.exports = SQLiteView;
