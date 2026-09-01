/** @babel */
/** @jsx etch.dom */
const etch = require("@lumine-code/etch");

module.exports = class SelectBox {
  constructor(props) {
    this.props = props;
    this.controller = lumine.menu.createSelectBox({
      items: props.items,
      value: props.value,
      disabled: props.disabled,
      ariaLabel: props.ariaLabel,
      className: props.className,
      onWillOpen: () => this.props.onWillOpen?.(this),
    });
    this.changeSubscription = this.controller.onDidChange((event) => {
      this.props.onDidChange?.(event);
    });
    etch.initialize(this);
    this.element.appendChild(this.controller.element);
  }

  update(props) {
    this.props = props;
    this.controller.setItems(props.items || [], { value: props.value });
    if (props.value !== undefined) this.controller.setValue(props.value);
    this.controller.setEnabled(props.disabled !== true);
    return Promise.resolve();
  }

  get value() {
    return this.controller.value;
  }

  get disabled() {
    return this.controller.element.disabled;
  }

  setValue(value, options) {
    return this.controller.setValue(value, options);
  }

  setEnabled(enabled) {
    this.controller.setEnabled(enabled);
  }

  focus() {
    this.controller.focus();
  }

  render() {
    return <span style={{ display: "contents" }} />;
  }

  destroy() {
    this.changeSubscription.dispose();
    this.controller.destroy();
    return etch.destroy(this);
  }
};
