describe("SQLite cancellation availability", () => {
  it("reads only the existing component and follows query/count activity", async () => {
    const main = (await lumine.packages.activatePackage("sqlite-view")).mainModule;
    const SQLiteView = require("../lib/sqlite-view");
    const view = Object.create(SQLiteView.prototype);
    const root = document.createElement("div");
    root.className = "sqlite-view";
    root.sqliteViewModel = view;
    const available = () => lumine.commands.canDispatch(root, "sqlite-view:cancel-query");
    view.ensureComponent = jasmine.createSpy("construct component");
    expect(available()).toBe(false);
    view.component = { queryRunning: true };
    expect(available()).toBe(true);
    view.component = { counting: true };
    expect(available()).toBe(true);
    view.component = { counting: false, queryRunning: false };
    expect(available()).toBe(false);
    expect(view.ensureComponent).not.toHaveBeenCalled();
    main.deactivate();
  });
});
