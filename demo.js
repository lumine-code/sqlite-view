// Authentic package usage. Run with lumine/script/demo.js; fixtures stay in demo/.
module.exports = {
  version: 1,
  dependencies: [],
  viewport: { width: 1200, height: 760 },
  async before() {},
  async prepare(context) {
    const { lumine, state, fixture, open } = context;
    state.editor = await open("data/notes.txt");
    await lumine.project.setPaths([fixture("data")]);
  },
  scenes: [
    {
      id: "scene-1",
      file: "demo.png",
      caption: "Browse the samples table and query a SQLite database.",
      timeout: 60000,
      async run(context) {
        const { lumine, state, fixture } = context;
        {
          state.document = await lumine.workspace.open(fixture("data/signals.sqlite"));
          await lumine.workspace.paneForItem(state.editor).destroyItem(state.editor, true);
        }
      },
      ready() {
        return Boolean(document.querySelector(".sqlite-view"));
      },
    },
  ],
  async cleanup() {},
};
