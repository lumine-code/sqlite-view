const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

describe("sqlite-view startup restoration", () => {
  let pack, directory, view;

  beforeEach(async () => {
    if (lumine.packages.getLoadedPackage("sqlite-view"))
      await lumine.packages.unloadPackage("sqlite-view", { serialize: false });
    directory = fs.mkdtempSync(path.join(os.tmpdir(), "sqlite-startup-"));
    const filePath = path.join(directory, "restored.sqlite");
    fs.writeFileSync(filePath, Buffer.from("SQLite format 3\0", "binary"));
    pack = lumine.packages.loadPackage("sqlite-view");
    pack.initializeForExternalUse("startup restoration spec");
    view = pack.mainModule.deserialize({ path: filePath });
  });

  afterEach(async () => {
    if (lumine.packages.getLoadedPackage("sqlite-view"))
      await lumine.packages.unloadPackage("sqlite-view", { serialize: false });
    view?.destroy();
    await lumine.fileWatchClient.settlePendingTeardown();
    fs.rmSync(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  });

  it("destroys a restored pane and its watcher when startup stops before activation", async () => {
    await pack.deactivate();
    expect(view.destroyed).toBe(true);
    expect(view.fileSubscriptions.disposed).toBe(true);
    expect(view.subscriptions.disposed).toBe(true);
  });
});
