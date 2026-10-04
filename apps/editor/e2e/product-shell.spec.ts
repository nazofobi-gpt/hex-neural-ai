import { expect, test, type Page } from "@playwright/test";

async function createWorkspace(page: Page, path = "/") {
  await page.goto(path);
  await page.getByRole("button", { name: "Continue with preview account" }).click();
  await expect(page.getByRole("heading", { name: "Create your workspace" })).toBeVisible();
  await page.getByRole("button", { name: "Create workspace" }).click();
  await expect(page.getByRole("navigation", { name: "Primary navigation" })).toBeVisible();
}

test("sign-in, workspace and guided project reach Builder by keyboard", async ({ page }) => {
  await createWorkspace(page);
  await page.screenshot({ path: "test-results/g255-home.png", fullPage: true });
  await page.getByRole("button", { name: "Create guided project" }).focus();
  await page.keyboard.press("Enter");
  await expect(page.getByRole("heading", { name: "First Neural Workflow" })).toBeVisible();
  await expect(page.getByRole("list", { name: "First-run checklist" })).toContainText("Project created");
  await page.screenshot({ path: "test-results/g255-project-overview.png", fullPage: true });
  await page.getByRole("button", { name: "Enter builder" }).click();
  await expect(page.getByRole("heading", { name: "Builder" })).toBeVisible();
  await expect(page.getByLabel(/Interactive hex canvas/)).toBeVisible();
});

test("project error is explicit and retry-safe", async ({ page }) => {
  await createWorkspace(page, "/?mockProjectError=1");
  await page.getByRole("button", { name: "Create guided project" }).click();
  await expect(page.getByRole("alert")).toContainText("Nothing was saved");
  await page.screenshot({ path: "test-results/g255-project-error.png", fullPage: true });
  await page.getByRole("button", { name: "Retry project creation" }).click();
  await expect(page.getByRole("heading", { name: "First Neural Workflow" })).toBeVisible();
});

test("navigation exposes intentional empty states and quick-create", async ({ page }) => {
  await createWorkspace(page);
  await page.getByRole("button", { name: "Activity", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Activity", level: 2 })).toBeVisible();
  await expect(page.getByText(/does not represent demo data/)).toBeVisible();
  await page.getByRole("button", { name: /Quick create/ }).click();
  await expect(page.getByRole("heading", { name: "First Neural Workflow" })).toBeVisible();
});
