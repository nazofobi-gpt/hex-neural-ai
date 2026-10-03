import { expect, test } from "@playwright/test";

test("design-system fixture exposes semantic states and deterministic visual evidence", async ({ page }, testInfo) => {
  await page.goto("/?design-system=1");
  await expect(page.getByTestId("design-system-fixture")).toBeVisible();
  await expect(page.getByRole("textbox", { name: "Name" })).toHaveValue("Capability node");
  await expect(page.getByRole("tab", { selected: true })).toContainText("Overview");
  await expect(page.getByRole("button", { name: "Inspect provenance" })).toBeVisible();

  for (const state of ["selected", "running", "success", "warning", "error", "disabled", "locked", "offline", "stale", "partial"]) {
    const card = page.getByTestId(`state-${state}`);
    await expect(card).toBeVisible();
    await expect(card).toContainText(new RegExp(state, "i"));
    await expect(card).toHaveCSS("border-left-style", state === "offline" || state === "stale" ? "dashed" : "solid");
  }

  await page.evaluate(() => { document.documentElement.dataset.contrast = "high"; });
  await expect(page.getByTestId("state-selected")).toHaveCSS("outline-style", "solid");

  const screenshot = await page.screenshot({ fullPage: true });
  await testInfo.attach("g256-design-system-fixture", { body: screenshot, contentType: "image/png" });
});
