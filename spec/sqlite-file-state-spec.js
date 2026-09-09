const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const SQLiteView = require("../lib/sqlite-view");

describe("SQLite file state", () => {
  let directory, filePath, view;

  beforeEach(() => {
    directory = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "sqlite-state-spec-")));
    filePath = path.join(directory, "database.sqlite");
    fs.writeFileSync(filePath, "SQLite format 3\0");
    view = new SQLiteView(filePath);
  });

  afterEach(async () => {
    const observation = view.file;
    view.destroy();
    await observation.closed;
    fs.rmSync(directory, { recursive: true, force: true });
  });

  it("reports removed and returns to unmodified when the file is available", () => {
    const states = [];
    view.onDidChangeFileState((state) => states.push(state));
    expect(view.getFileState()).toBe(lumine.FileState.UNMODIFIED);

    fs.unlinkSync(filePath);
    view.reconcileFile();
    expect(view.getFileState()).toBe(lumine.FileState.REMOVED);

    fs.writeFileSync(filePath, "SQLite format 3\0");
    view.reconcileFile();
    expect(view.getFileState()).toBe(lumine.FileState.UNMODIFIED);
    expect(states).toEqual([lumine.FileState.REMOVED, lumine.FileState.UNMODIFIED]);
  });
});
