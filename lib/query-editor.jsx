/** @jsx etch.dom */
const etch = require("@lumine-code/etch");
const { TextBuffer } = require("lumine");
const { statementAtSource, checkQueryLength } = require("./sql-source");

const SQL_GRAMMAR_SCOPE = "source.sql";

class QueryEditor {
  constructor(props) {
    this.props = props;
    etch.initialize(this);
    this.editor = lumine.workspace.buildTextEditor({
      softWrapped: true,
      autoHeight: false,
      lineNumberGutterVisible: false,
      placeholderText: "SELECT * FROM …",
    });
    this.editor.element.classList.add("sqlite-view-query-input");
    this.editor.element.setAttribute("input", "");
    this.applyGrammar();
    this.editor.setText(TextBuffer.createTextSnapshot(props.text || ""));
    this.element.appendChild(this.editor.element);
    this.changeDisposable = this.editor.getBuffer().onDidChangeText(() => {
      const source = this.editor.getBuffer().getTextSnapshot();
      this.props.onDidChange?.(source.length <= 65536 ? source.toString() : source);
    });
  }

  update(props) {
    this.props = props;
    if (props.text !== undefined) {
      const source = TextBuffer.createTextSnapshot(props.text);
      if (!source.equals(this.editor.getBuffer().getTextSnapshot())) this.editor.setText(source);
    }
    return Promise.resolve();
  }

  getStatementSource({ signal } = {}) {
    const buffer = this.editor.getBuffer(),
      range = this.editor.getSelectedBufferRange();
    const revision = buffer.getTextRevision();
    checkQueryLength(
      buffer.characterIndexForPosition(range.end) - buffer.characterIndexForPosition(range.start),
    );
    const selected = buffer.getTextInRange(range);
    if (selected.trim()) return selected;
    const point = this.editor.getCursorBufferPosition();
    const index = this.editor.getBuffer().characterIndexForPosition(point);
    const source = buffer.getTextSnapshot();
    if (source.length <= 65536) return this.props.statementAt(source.toString(), index);
    return statementAtSource(source, index, {
      signal,
      isCurrent: () =>
        !this.destroyed &&
        buffer.getTextRevision() === revision &&
        this.editor.getSelectedBufferRange().isEqual(range),
    });
  }

  applyGrammar() {
    if (!this.editor || this.destroyed) return false;
    const assigned = lumine.grammars.assignLanguageMode(this.editor.getBuffer(), SQL_GRAMMAR_SCOPE);
    if (assigned) {
      this.grammarDisposable?.dispose();
      this.grammarDisposable = null;
    } else if (!this.grammarDisposable) {
      this.grammarDisposable = lumine.grammars.onDidAddGrammar((grammar) => {
        if (grammar.scopeName === SQL_GRAMMAR_SCOPE) this.applyGrammar();
      });
    }
    return assigned;
  }

  focus() {
    this.editor.element.focus({ preventScroll: true });
  }

  destroy() {
    if (this.destroyed) return;
    this.destroyed = true;
    this.grammarDisposable?.dispose();
    this.grammarDisposable = null;
    this.changeDisposable?.dispose();
    this.editor?.destroy();
    return etch.destroy(this);
  }

  render() {
    return <div className="sqlite-view-query-editor" />;
  }
}

module.exports = QueryEditor;
