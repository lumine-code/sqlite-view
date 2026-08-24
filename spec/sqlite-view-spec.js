describe("SQLite View", () => {
  it("activates successfully", async () => {
    const pack = await lumine.packages.activatePackage("sqlite-view");
    expect(pack.mainModule).toBeDefined();
  });
});
