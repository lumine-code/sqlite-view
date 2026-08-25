const QueryEditor = require("../lib/query-editor");

describe("SQLite query editor", () => {
  let component;
  let languageSqlWasActive;

  beforeEach(async () => {
    languageSqlWasActive = lumine.packages.isPackageActive("language-sql");
    await lumine.packages.activatePackage("language-sql");
    await lumine.packages.activatePackage("sqlite-view");
  });

  afterEach(async () => {
    await component?.destroy();
    component = null;
    await lumine.packages.deactivatePackage("sqlite-view");
    if (!languageSqlWasActive) await lumine.packages.deactivatePackage("language-sql");
  });

  it("applies the SQL grammar when it loads after a restored editor", () => {
    let grammarAvailable = false;
    let grammarAdded;
    const dispose = jasmine.createSpy("dispose grammar listener");
    spyOn(lumine.grammars, "onDidAddGrammar").and.callFake((callback) => {
      grammarAdded = callback;
      return { dispose };
    });
    const realAssign = lumine.grammars.assignLanguageMode.bind(lumine.grammars);
    const assign = spyOn(lumine.grammars, "assignLanguageMode").and.callFake(
      (buffer, scopeName) => grammarAvailable && realAssign(buffer, scopeName),
    );

    component = new QueryEditor({
      text: "SELECT 1",
      statementAt: (text) => text,
      onDidChange() {},
    });

    expect(grammarAdded).toEqual(jasmine.any(Function));
    expect(assign).toHaveBeenCalledOnceWith(component.editor.getBuffer(), "source.sql");
    grammarAdded({ scopeName: "source.js" });
    expect(assign).toHaveBeenCalledTimes(1);

    grammarAvailable = true;
    grammarAdded({ scopeName: "source.sql" });

    expect(assign).toHaveBeenCalledWith(component.editor.getBuffer(), "source.sql");
    expect(component.editor.getGrammar().scopeName).toBe("source.sql");
    expect(component.editor.getText()).toBe("SELECT 1");
    expect(dispose).toHaveBeenCalledTimes(1);
    expect(component.grammarDisposable).toBeNull();
  });

  it("disposes an unresolved grammar listener when the editor is destroyed", async () => {
    let grammarAdded;
    const dispose = jasmine.createSpy("dispose grammar listener");
    const assign = spyOn(lumine.grammars, "assignLanguageMode").and.returnValue(false);
    spyOn(lumine.grammars, "onDidAddGrammar").and.callFake((callback) => {
      grammarAdded = callback;
      return { dispose };
    });
    component = new QueryEditor({
      text: "SELECT 1",
      statementAt: (text) => text,
      onDidChange() {},
    });
    assign.calls.reset();

    await component.destroy();
    expect(dispose).toHaveBeenCalledTimes(1);
    grammarAdded({ scopeName: "source.sql" });
    expect(assign).not.toHaveBeenCalled();
  });
});
