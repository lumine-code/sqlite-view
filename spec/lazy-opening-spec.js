const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { DatabaseSync } = require("node:sqlite");

describe("SQLite View native opening", () => {
  let pack, main, directory, file, views;

  beforeEach(async () => {
    jasmine.attachToDOM(lumine.workspace.getElement());
    if (lumine.packages.isPackageLoaded("sqlite-view"))
      await lumine.packages.unloadPackage("sqlite-view");
    pack = await lumine.packages.activatePackage("sqlite-view");
    main = pack.mainModule;
    directory = fs.mkdtempSync(path.join(os.tmpdir(), "sqlite-view-import-"));
    file = path.join(directory, "test.sqlite");
    const db = new DatabaseSync(file);
    db.exec("CREATE TABLE sample(value TEXT);");
    db.close();
    views = [];
  });

  afterEach(async () => {
    for (const view of views) await view.destroy();
    await lumine.packages.unloadPackage("sqlite-view");
    await lumine.fileWatchClient.settlePendingTeardown();
    const relative = path.relative(fs.realpathSync(os.tmpdir()), fs.realpathSync(directory));
    if (path.isAbsolute(relative) || relative === ".." || relative.startsWith(`..${path.sep}`))
      throw Error("Unsafe database fixture path");
    await fs.promises.rm(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  });

  async function holdImport() {
    const module = await main.importViewRuntime();
    let release;
    spyOn(main, "importViewRuntime").and.returnValue(
      new Promise((resolve) => (release = () => resolve(module))),
    );
    return release;
  }

  it("keeps synchronous deserialization and leaves ordinary files to their existing opener", async () => {
    spyOn(main, "importViewRuntime").and.callThrough();
    const restored = main.deserialize({ path: file });
    views.push(restored);
    expect(restored.then).toBeUndefined();
    const text = path.join(directory, "ordinary.txt");
    fs.writeFileSync(text, "ordinary text");
    const editor = await lumine.workspace.open(text);
    expect(editor.getText()).toBe("ordinary text");
    expect(main.importViewRuntime).not.toHaveBeenCalled();
    editor.destroy();
  });

  it("shares native renderer loading and returns the current-generation pane item", async () => {
    spyOn(main, "importViewRuntime").and.callThrough();
    await Promise.all([main.loadViewRuntime(), main.loadViewRuntime()]);
    expect(main.importViewRuntime).toHaveBeenCalledTimes(1);
    const view = await lumine.workspace.open(file);
    views.push(view);
    const View = require(path.join(pack.path, "lib/sqlite-view.js"));
    expect(view instanceof View).toBe(true);
  });

  it("does not create an item after an opener is aborted while importing", async () => {
    const release = await holdImport();
    const controller = new AbortController();
    const pending = main.openDatabaseView(file, { signal: controller.signal });
    controller.abort();
    release();
    expect(await pending).toBeUndefined();
  });

  it("does not publish a pane item from an unloaded package generation", async () => {
    const release = await holdImport();
    const pending = main.openDatabaseView(file);
    await lumine.packages.unloadPackage("sqlite-view");
    pack = await lumine.packages.activatePackage("sqlite-view");
    main = pack.mainModule;
    release();
    expect(await pending).toBeUndefined();
    const view = await main.openDatabaseView(file);
    views.push(view);
    const View = require(path.join(pack.path, "lib/sqlite-view.js"));
    expect(view instanceof View).toBe(true);
  });

  it("retries a failed renderer import on the next database open", async () => {
    spyOn(main, "importViewRuntime").and.rejectWith(new Error("Held database import failed"));
    await expectAsync(main.openDatabaseView(file)).toBeRejectedWithError(
      "Held database import failed",
    );
    main.importViewRuntime.and.callThrough();
    views.push(await main.openDatabaseView(file));
    expect(main.importViewRuntime).toHaveBeenCalledTimes(2);
  });

  it("does not create a view for a file replaced while its renderer loads", async () => {
    const release = await holdImport();
    const pending = main.openDatabaseView(file);
    fs.writeFileSync(file, "replaced with ordinary text");
    release();
    expect(await pending).toBeUndefined();
  });

  it("does not create into a presentation window closed while importing", async () => {
    const window = await lumine.workspace.openEditorWindow({ show: false });
    const release = await holdImport();
    const pending = main.openDatabaseView(file, { window });
    await lumine.workspace.discardEditorWindows();
    release();
    expect(await pending).toBeUndefined();
  });
});
