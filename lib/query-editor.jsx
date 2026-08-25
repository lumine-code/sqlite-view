/** @jsx etch.dom */
const etch = require("@lumine-code/etch");

const SQL_GRAMMAR_SCOPE = "source.sql";

class QueryEditor {
  constructor(props) {
    this.props = props;
    etch.initialize(this);
    this.editor = lumine.workspace.buildTextEditor({
      softWrapped: true,
      lineNumberGutterVisible: false,
      placeholderText: "SELECT * FROM …",
    });
    this.editor.element.classList.add("sqlite-view-query-input");
    this.editor.element.setAttribute("input", "");
    this.applyGrammar();
    this.editor.setText(props.text || "");
    this.element.appendChild(this.editor.element);
    this.changeDisposable = this.editor.onDidChange(() =>
      this.props.onDidChange?.(this.editor.getText()),
    );
  }

  update(props) {
    this.props = props;
    if (props.text !== undefined && props.text !== this.editor.getText())
      this.editor.setText(props.text);
    return Promise.resolve();
  }

  getStatementSource() {
    const selected = this.editor.getSelectedText();
    if (selected.trim()) return selected;
    const point = this.editor.getCursorBufferPosition();
    const index = this.editor.getBuffer().characterIndexForPosition(point);
    return this.props.statementAt(this.editor.getText(), index);
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
