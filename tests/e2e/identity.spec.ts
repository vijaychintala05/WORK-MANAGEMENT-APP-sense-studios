import { test, expect, devices } from "@playwright/test";
import { createRequire } from "node:module";
import { resolve } from "node:path";

const ownerEmail = "s02-e2e-owner@example.test";
const bootstrapSecret = process.env.S02_E2E_BOOTSTRAP_SECRET;

async function cleanTestOwner(): Promise<void> {
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) return;
  const parsed = new URL(databaseUrl);
  if (!(["127.0.0.1", "localhost"].includes(parsed.hostname) || parsed.hostname === "db") || !/(?:_test|_fresh)$/.test(parsed.pathname.slice(1))) {
    throw new Error("S02 E2E cleanup requires a dedicated local test database");
  }
  const apiRequire = createRequire(resolve("apps/api/package.json"));
  const { Client } = apiRequire("pg") as typeof import("pg");
  const client = new Client({ connectionString: databaseUrl });
  await client.connect();
  try {
    await client.query("BEGIN");
    const found = await client.query<{ id: string }>('SELECT id FROM accounts WHERE "normalizedEmail" = $1', [ownerEmail]);
    if (found.rows[0]) {
      const id = found.rows[0].id;
      await client.query('DELETE FROM identity_enrollment_grants WHERE "accountId" = $1 OR "authorizedByAccountId" = $1', [id]);
      await client.query('DELETE FROM staff_recovery_authorizations WHERE "accountId" = $1 OR "authorizedByAccountId" = $1', [id]);
      await client.query('DELETE FROM security_events WHERE "actorId" = $1 OR "subjectId" = $1', [id]);
      await client.query('DELETE FROM webauthn_challenges WHERE "accountId" = $1', [id]);
      await client.query('DELETE FROM sessions WHERE "accountId" = $1', [id]);
      await client.query('DELETE FROM owner_recovery_codes WHERE "accountId" = $1', [id]);
      await client.query('DELETE FROM passkey_credentials WHERE "accountId" = $1', [id]);
      await client.query('DELETE FROM accounts WHERE id = $1', [id]);
    }
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    await client.end();
  }
}

async function virtualPasskey(page: import("@playwright/test").Page) {
  const cdp = await page.context().newCDPSession(page);
  await cdp.send("WebAuthn.enable");
  await cdp.send("WebAuthn.addVirtualAuthenticator", {
    options: {
      protocol: "ctap2",
      transport: "internal",
      hasResidentKey: true,
      hasUserVerification: true,
      isUserVerified: true,
      automaticPresenceSimulation: true
    }
  });
  return cdp;
}

test("Owner passkey enrollment, desktop and mobile login, session restore, and logout", async ({ browser, baseURL }) => {
  test.skip(!bootstrapSecret, "Set S02_E2E_BOOTSTRAP_SECRET for the dedicated S02 test database.");
  test.skip(!process.env.DATABASE_URL, "Set DATABASE_URL for the dedicated S02 test database.");
  await cleanTestOwner();
  const desktop = await browser.newContext({ ...devices["Desktop Chrome"], baseURL });
  const mobile = await browser.newContext({ ...devices["Pixel 7"], baseURL });
  try {
    const desktopPage = await desktop.newPage();
    await virtualPasskey(desktopPage);
    await desktopPage.goto("/bootstrap");
    await desktopPage.getByLabel("Owner work email").fill(ownerEmail);
    await desktopPage.getByLabel("One-time setup secret").fill(bootstrapSecret!);
    await desktopPage.getByRole("button", { name: "Continue", exact: true }).click();
    await desktopPage.getByRole("button", { name: "Register Owner passkey" }).click();
    await expect(desktopPage.getByRole("heading", { name: "You’re signed in." })).toBeVisible();

    await mobile.addCookies(await desktop.cookies());
    const mobilePage = await mobile.newPage();
    await virtualPasskey(mobilePage);
    await mobilePage.goto("/");
    await expect(mobilePage).toHaveURL(/\/$/);
    await expect(mobilePage.getByRole("heading", { name: "Secure your Owner account" })).toBeVisible();
    await mobilePage.getByRole("button", { name: "Add second passkey" }).click();
    await expect(mobilePage.getByRole("button", { name: "Create offline recovery code" })).toBeVisible();
    await mobilePage.getByRole("button", { name: "Create offline recovery code" }).click();
    await expect(mobilePage.getByLabel("One-time offline recovery code")).toHaveValue(/.{32,}/);
    await mobilePage.getByLabel("I stored this recovery code offline where only I can access it.").check();
    await mobilePage.getByRole("button", { name: "Confirm offline storage" }).click();
    await mobilePage.reload();
    await expect(mobilePage).toHaveURL(/\/dashboard(?:\?.*)?$/);
    await expect(mobilePage.getByRole("heading", { name: "Dashboard", exact: true })).toBeVisible();
    await mobilePage.goto("/my-work");
    await expect(mobilePage.getByRole("heading", { name: "My work", exact: true, level: 1 })).toBeVisible();
    // Identity enrollment has not created an organization. Do not turn denied
    // source reads into invented empty counts; domain fixtures cover ready work.
    await expect(mobilePage.getByRole("alert").filter({hasText:"You do not have access to these tasks."})).toBeVisible();
    await expect(mobilePage.getByText("No pending decisions in this list.", { exact: true })).toHaveCount(0);
    await expect(mobilePage.getByRole("heading", { name: "Secure your Owner account" })).toHaveCount(0);

    await mobilePage.goto("/workspace");
    await mobilePage.getByRole("button", { name: "Log out" }).click();
    await expect(mobilePage.getByRole("heading", { name: "Sign in to view your dashboard" })).toBeVisible();
    await mobilePage.goto("/");
    await mobilePage.getByLabel("Work email", { exact: true }).fill(ownerEmail);
    await mobilePage.getByRole("button", { name: "Continue with passkey" }).click();
    await expect(mobilePage).toHaveURL(/\/dashboard(?:\?.*)?$/);
    await expect(mobilePage.getByRole("heading", { name: "Dashboard", exact: true })).toBeVisible();
    await mobilePage.goto("/my-work");
    await expect(mobilePage.getByRole("heading", { name: "My work", exact: true, level: 1 })).toBeVisible();

    await desktop.addCookies(await mobile.cookies());
    await desktopPage.goto("/workspace");
    await desktopPage.getByRole("button", { name: "Log out" }).click();
    await expect(desktopPage.getByRole("heading", { name: "Sign in to view your dashboard" })).toBeVisible();
    await desktopPage.goto("/");
    await desktopPage.getByLabel("Work email", { exact: true }).fill(ownerEmail);
    await desktopPage.getByRole("button", { name: "Continue with passkey" }).click();
    await expect(desktopPage).toHaveURL(/\/dashboard(?:\?.*)?$/);
    await expect(desktopPage.getByRole("heading", { name: "Dashboard", exact: true })).toBeVisible();
    await desktopPage.goto("/my-work");
    await expect(desktopPage.getByRole("heading", { name: "My work", exact: true, level: 1 })).toBeVisible();
  } finally {
    await desktop.close();
    await mobile.close();
    await cleanTestOwner();
  }
});
