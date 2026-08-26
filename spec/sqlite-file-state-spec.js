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

  afterEach(() => {
    view.destroy();
    fs.rmSync(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  });

  it("reports removed and returns to unmodified when the file is available", () => {
    const states = [];
    view.onDidChangeFileState((state) => states.push(state));
    expect(view.getFileState()).toBe(lumine.FileState.UNMODIFIED);

    view.file.emitter.emit("did-delete");
    expect(view.getFileState()).toBe(lumine.FileState.REMOVED);

    advanceClock(1000);
    expect(view.getFileState()).toBe(lumine.FileState.UNMODIFIED);
    expect(states).toEqual([lumine.FileState.REMOVED, lumine.FileState.UNMODIFIED]);
  });
});
