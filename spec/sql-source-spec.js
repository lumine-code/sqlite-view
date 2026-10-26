const { TextBuffer } = require("lumine");
const { statementAt } = require("../lib/sql-statement");
const { statementAtSource } = require("../lib/sql-source");

describe("Snapshot SQL statement selection", () => {
  it("matches the existing lexer across comments, quoting and every cursor boundary", async () => {
    const inputs = [
      "",
      " \r\n",
      "SELECT 1;\nSELECT 2;  ",
      "-- before;\nSELECT 'a;''b'; /* ; */ SELECT \"a;\"\"b\";",
      "SELECT `a;``b`, [a;]]b]; SELECT 4",
      "SELECT '\n;'; -- after",
      ";;; ",
    ];
    for (const text of inputs) {
      const source = TextBuffer.createTextSnapshot(text);
      for (let index = 0; index <= text.length; index++)
        expect(await statementAtSource(source, index)).toBe(statementAt(text, index));
    }
  });

  it("finds a bounded query after a large prefix without reading the complete source", async () => {
    const text = "SELECT 1;\n".repeat(10000) + "SELECT 42;";
    const source = TextBuffer.createTextSnapshot(text);
    const slice = spyOn(Object.getPrototypeOf(source), "slice").and.callThrough();
    expect(await statementAtSource(source, text.length)).toBe("SELECT 42;");
    expect(slice.calls.count()).toBe(1);
    expect(slice.calls.mostRecent().args[1] - slice.calls.mostRecent().args[0]).toBe(10);
  });

  it("rejects an oversized selected statement without materializing it", async () => {
    const source = TextBuffer.createTextSnapshot("SELECT '" + "x".repeat(1048576) + "';");
    await expectAsync(statementAtSource(source, source.length)).toBeRejectedWithError(
      /1 Mi UTF-16/,
    );
  });

  it("cancels while crossing escaped quote pairs that skip aligned checkpoints", async () => {
    jasmine.useRealClock();
    const source = TextBuffer.createTextSnapshot("'" + "''".repeat(100000) + "';");
    const controller = new AbortController();
    const pending = statementAtSource(source, source.length, { signal: controller.signal });
    controller.abort();
    await expectAsync(pending).toBeRejectedWith(jasmine.objectContaining({ name: "AbortError" }));
  });
});
