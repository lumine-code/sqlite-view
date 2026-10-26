describe("SQLite query editor", () => {
  let component;
  let languageSqlWasActive;
  let QueryEditor;

  beforeEach(async () => {
    languageSqlWasActive = lumine.packages.isPackageActive("language-sql");
    await lumine.packages.activatePackage("language-sql");
    await lumine.packages.activatePackage("sqlite-view");
    QueryEditor = require("../lib/query-editor");
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
  it("keeps a huge query snapshot editable while executing a small selection", async () => {
    const { TextBuffer } = require("lumine");
    let source = TextBuffer.createTextSnapshot("x".repeat(32768));
    while (source.canMaterialize()) source = source.replace(source.length, source.length, source);
    source = source.replace(0, 0, "SELECT 42;\n");
    const changed = jasmine.createSpy("changed");
    component = new QueryEditor({
      text: source,
      statementAt: (text) => text,
      onDidChange: changed,
    });
    const read = spyOn(component.editor, "getText").and.throwError("Whole query read");
    try {
      await component.update({ text: source, statementAt: (text) => text, onDidChange: changed });
      component.editor.setSelectedBufferRange([
        [0, 0],
        [0, 10],
      ]);
      expect(component.getStatementSource()).toBe("SELECT 42;");
      component.editor.setCursorBufferPosition([0, 10]);
      component.editor.insertText(" ");
      expect(changed.calls.mostRecent().args[0].length).toBe(source.length + 1);
      expect(typeof changed.calls.mostRecent().args[0].chunks).toBe("function");
    } finally {
      read.and.callThrough();
    }
  });
});
