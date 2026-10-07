const fs = require("fs");
const path = require("path");

describe("SQLite sidebar CSS roles", () => {
  let stylesheet, view;
  beforeEach(() => {
    stylesheet = lumine.styles.addStyleSheet(
      fs.readFileSync(path.join(__dirname, "../styles/main.css"), "utf8"),
      { priority: 1000 },
    );
    view = document.createElement("div");
    view.className = "sqlite-view";
    for (const [name, value] of Object.entries({
      "background-color-selected": "rgb(15, 25, 35)",
      "text-color-selected": "rgb(230, 240, 250)",
      "text-color-highlight": "rgb(1, 2, 3)",
      "text-color-subtle": "rgb(80, 90, 100)",
      "data-grid-muted-color": "rgb(180, 190, 200)",
      "data-grid-header-color": "rgb(30, 40, 50)",
    }))
      view.style.setProperty(`--${name}`, value);
    view.innerHTML =
      '<div class="sqlite-view-object-group-title">Tables</div><button class="sqlite-view-object selected"><span>records</span><small>12 rows</small></button>';
    jasmine.attachToDOM(view);
  });
  afterEach(() => stylesheet.dispose());

  it("uses the selected foreground for both object names and their small counts", () => {
    const selected = view.querySelector("button");
    expect(getComputedStyle(selected).backgroundColor).toBe("rgb(15, 25, 35)");
    expect(getComputedStyle(selected.querySelector("span")).color).toBe("rgb(230, 240, 250)");
    expect(getComputedStyle(selected.querySelector("small")).color).toBe("rgb(230, 240, 250)");
  });

  it("lets the grid palette control the sidebar's data headings", () => {
    const heading = getComputedStyle(view.querySelector(".sqlite-view-object-group-title"));
    expect(heading.backgroundColor).toBe("rgb(30, 40, 50)");
    expect(heading.color).toBe("rgb(180, 190, 200)");
  });
});
