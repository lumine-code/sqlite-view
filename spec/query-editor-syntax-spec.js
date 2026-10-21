describe("SQL query input syntax updates", () => {
  let view;
  afterEach(() => view?.destroy());
  it("reports source edits without reporting grammar paint as query input", async () => {
    jasmine.useRealClock();
    await lumine.packages.activatePackage("language-sql");
    const QueryEditor = require("../lib/query-editor");
    const changed = jasmine.createSpy("query changed");
    view = new QueryEditor({ text: "SELECT 1;", onDidChange: changed });
    await view.editor.whenGrammarSettled();
    const buffer = view.editor.getBuffer();
    await buffer.getLanguageMode().refresh?.();
    buffer.getLanguageMode().emitter.emit("did-change-highlighting", buffer.getRange());
    expect(changed).not.toHaveBeenCalled();
    view.editor.insertText(" ");
    expect(changed).toHaveBeenCalledOnceWith(view.editor.getText());
  });
});
