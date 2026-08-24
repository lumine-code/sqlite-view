/** @jsx etch.dom */
const etch = require("@lumine-code/etch");

class QueryEditor {
  constructor(props) {
    this.props = props;
    etch.initialize(this);
    this.editor = lumine.workspace.buildTextEditor({
      softWrapped: true,
      lineNumberGutterVisible: true,
      placeholderText: "SELECT * FROM …",
    });
    this.editor.element.classList.add("sqlite-view-query-input");
    const grammar = lumine.grammars.grammarForScopeName("source.sql");
    if (grammar) lumine.grammars.assignLanguageMode(this.editor.getBuffer(), grammar.scopeName);
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

  focus() {
    this.editor.element.focus({ preventScroll: true });
  }

  destroy() {
    this.changeDisposable?.dispose();
    this.editor?.destroy();
    return etch.destroy(this);
  }

  render() {
    return <div className="sqlite-view-query-editor" />;
  }
}

module.exports = QueryEditor;
