import { test, expect, type Page } from "@playwright/test";
const wallet = "11111111111111111111111111111111",
  merchant = "So11111111111111111111111111111111111111112";
async function fixture(
  page: Page,
  role: "merchant" | "subscriber" | "resolver" | "admin",
) {
  await page.addInitScript(
    ({ wallet }) => {
      const account = {
        address: wallet,
        publicKey: new Uint8Array(32),
        chains: ["solana:devnet"],
        features: ["solana:signMessage", "solana:signTransaction"],
      };
      const fake = {
        version: "1.0.0",
        name: "Recora Test Wallet",
        icon: "data:image/svg+xml;base64,PHN2Zy8+",
        chains: ["solana:devnet"],
        accounts: [account],
        features: {
          "standard:connect": {
            version: "1.0.0",
            connect: async () => ({ accounts: [account] }),
          },
          "standard:events": { version: "1.0.0", on: () => () => {} },
          "solana:signMessage": {
            version: "1.0.0",
            signMessage: async () => [{ signature: new Uint8Array(64) }],
          },
          "solana:signTransaction": {
            version: "1.0.0",
            supportedTransactionVersions: ["legacy"],
            signTransaction: async (input: { transaction: Uint8Array }) => [
              { signedTransaction: input.transaction },
            ],
          },
        },
      };
      window.addEventListener("wallet-standard:app-ready", (event: Event) =>
        (event as CustomEvent).detail.register(fake),
      );
      window.dispatchEvent(
        new CustomEvent("wallet-standard:register-wallet", {
          detail: (api: { register: (wallet: unknown) => void }) =>
            api.register(fake),
        }),
      );
    },
    { wallet },
  );
  await page.route("**/api/**", async (route) => {
    const path = new URL(route.request().url()).pathname;
    const data: Record<string, unknown> = {
      "/api/network": {
        cluster: "devnet",
        programId: merchant,
        mint: { address: merchant, decimals: 6 },
        config: {
          authority: role === "admin" ? wallet : merchant,
          pendingAuthority: merchant,
          mint: merchant,
          feeBps: 50,
          paused: false,
        },
      },
      "/api/auth/challenge": { id: "x".repeat(64), message: "test challenge" },
      "/api/auth/verify": { wallet },
      "/api/auth/logout": { ok: true },
      "/api/me": {
        wallet,
        merchant: role === "merchant" ? { address: merchant } : null,
      },
      "/api/health": {
        queue: [],
        errors: [],
        checkpoint: {
          updated_at: new Date().toISOString(),
          data: { complete: true },
        },
      },
      [`/api/merchants/${merchant}/analytics`]: {
        revenue: "123000000",
        held: "42000000",
        startingActive: 10,
        churned: 1,
        churn: 0.1,
      },
      "/api/subscriptions": {
        items: [
          {
            address: merchant,
            kind: "subscription",
            state: "active",
            price: "10000000",
            openCharges: "0",
            subscriber: wallet,
          },
        ],
        nextCursor: null,
      },
      "/api/disputes": {
        items: [
          {
            address: merchant,
            kind: "charge",
            state: "contested",
            amount: "10000000",
            cycle: "0",
            contestedAt: "1780000000",
            disputeSecs: "86400",
          },
        ],
        nextCursor: null,
      },
      "/api/charges": {
        items: [
          {
            address: merchant,
            kind: "charge",
            state: "held",
            amount: "10000000",
            pulledAt: Math.floor(Date.now() / 1000).toString(),
            reviewSecs: "86400",
          },
        ],
        nextCursor: null,
      },
      [`/api/plans/${merchant}`]: {
        address: merchant,
        price: "10000000",
        decimals: 6,
        merchant,
        mint: merchant,
        intervalSecs: "86400",
        reviewSecs: "3600",
        resolver: wallet,
        resolverFeeBps: 100,
      },
    };
    await route.fulfill({
      json: data[path] || { items: [], nextCursor: null },
    });
  });
}
async function capture(page: Page, name: string) {
  expect(
    await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth),
  ).toBeTruthy();
  await page.screenshot({
    path: `test-results/${name}-${test.info().project.name}.png`,
    fullPage: true,
  });
}
async function connect(page: Page) {
  await page
    .getByRole("button", { name: "Connect wallet", exact: true })
    .first()
    .click();
  await page.getByRole("button", { name: "Recora Test Wallet" }).click();
  await expect(page.getByRole("dialog")).toBeHidden();
}
test("merchant overview and plan form work without layout overflow", async ({
  page,
}) => {
  await fixture(page, "merchant");
  await page.goto("/");
  await connect(page);
  await expect(page.getByText("123", { exact: false }).first()).toBeVisible();
  await page.getByRole("button", { name: "Create plan" }).click();
  await expect(page.getByRole("dialog")).toBeVisible();
  await expect(page.getByLabel("Price per cycle")).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(page.getByRole("dialog")).toBeHidden();
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBeTruthy();
  await page.screenshot({
    path: `test-results/overview-${test.info().project.name}.png`,
    fullPage: true,
  });
});
test("merchant login succeeds when operational health is forbidden", async ({ page }) => {
  await fixture(page, "merchant");
  await page.route("**/api/health", (route) => route.fulfill({
    status: 403, json: { error: "Protocol authority required" },
  }));
  await page.goto("/");
  await connect(page);
  await expect(page.getByRole("button", { name: "Create plan" })).toBeVisible();
  await expect(page.getByText("Operational status available to protocol administrators")).toBeVisible();
  await expect(page.getByText("Protocol authority required")).toBeHidden();
});
test("subscriber can review cancellation and dispute actions", async ({
  page,
}) => {
  await fixture(page, "subscriber");
  await page.goto("/subscriptions");
  await connect(page);
  await expect(page.getByRole("button", { name: "Close", exact: true })).toHaveCount(0);
  await capture(page, "subscriptions");
  await page.getByRole("button", { name: "Cancel", exact: true }).click();
  await expect(
    page.getByText("Future billing stops.", { exact: false }),
  ).toBeVisible();
  await page.keyboard.press("Escape");
  await page.getByRole("button", { name: "Open dispute" }).click();
  await expect(
    page.getByLabel("Evidence reference", { exact: false }),
  ).toBeVisible();
});
test("resolver can open a payout split preview", async ({ page }) => {
  await fixture(page, "resolver");
  await page.goto("/resolver");
  await connect(page);
  await capture(page, "resolver");
  await page.getByRole("button", { name: "Review & rule" }).click();
  await expect(
    page.getByText("Merchant gross share: 5 tokens", { exact: false }),
  ).toBeVisible();
  await capture(page, "resolution-dialog");
});
test("admin actions are available only for the authority wallet", async ({
  page,
}) => {
  await fixture(page, "admin");
  await page.goto("/admin");
  await connect(page);
  await expect(
    page.getByRole("button", { name: "Pause new subscriptions" }),
  ).toBeEnabled();
  await capture(page, "admin");
  await page.getByRole("button", { name: "update config fee" }).click();
  await expect(page.getByLabel("Protocol fee", { exact: false })).toBeVisible();
});
test("public checkout explains cycles and shared delegate allowance", async ({
  page,
}) => {
  await fixture(page, "subscriber");
  await page.goto(`/checkout/${merchant}`);
  await expect(page.getByText("120 tokens", { exact: true })).toBeVisible();
  await page.getByLabel("Number of billing cycles").fill("2");
  await expect(page.getByText("20 tokens", { exact: true })).toBeVisible();
  await expect(
    page.getByText("No payment is pulled by subscribing.", { exact: false }),
  ).toBeVisible();
  await capture(page, "checkout");
});

test("merchant integrations expose filters, one-time secrets and delivery attempts", async ({
  page,
}) => {
  await fixture(page, "merchant");
  const base = `/api/merchants/${merchant}`;
  await page.route(`**${base}/webhooks`, (route) =>
    route.fulfill({
      json:
        route.request().method() === "POST"
          ? { id: "endpoint-1", secret: "fixture-signing-secret" }
          : { items: [] },
    }),
  );
  await page.route(`**${base}/keys`, (route) =>
    route.fulfill({
      json:
        route.request().method() === "POST"
          ? { id: "key-1", key: "fixture-read-key" }
          : { items: [] },
    }),
  );
  await page.route(`**${base}/deliveries`, (route) =>
    route.fulfill({
      json: {
        items: [
          {
            id: "delivery-1",
            status: "failed",
            attempts: 6,
            error: "HTTP 503",
            payload: { type: "charge.pulled" },
          },
        ],
      },
    }),
  );
  await page.route(`**${base}/deliveries/delivery-1`, (route) =>
    route.fulfill({
      json: {
        items: [
          {
            id: "attempt-1",
            status_code: 503,
            error: "HTTP 503",
            attempted_at: new Date().toISOString(),
          },
        ],
      },
    }),
  );
  await page.goto("/merchant/integrations");
  await connect(page);
  await page
    .getByLabel("Public HTTPS endpoint")
    .fill("https://merchant.example/recora");
  await page
    .getByLabel("Events (leave empty for all)")
    .fill("charge.pulled, subscription.lapsed");
  const registration = page.waitForRequest(
    (request) =>
      request.url().endsWith(`${base}/webhooks`) && request.method() === "POST",
  );
  await capture(page, "integrations");
  await page.getByRole("button", { name: "Register endpoint" }).click();
  expect((await registration).postDataJSON().filters).toEqual([
    "charge.pulled",
    "subscription.lapsed",
  ]);
  await expect(
    page.getByText("fixture-signing-secret", { exact: true }),
  ).toBeVisible();
  await page.keyboard.press("Escape");
  await page.getByLabel("Key name").fill("Application backend");
  await page.getByRole("button", { name: "Create read key" }).click();
  await expect(
    page.getByText("fixture-read-key", { exact: true }),
  ).toBeVisible();
  await page.keyboard.press("Escape");
  await page.getByRole("button", { name: "View attempts" }).click();
  await expect(
    page.getByRole("dialog").getByText("HTTP 503", { exact: true }),
  ).toBeVisible();
  await page.keyboard.press("Escape");
});

test("workspace navigation identifies the current page and supports keyboard access", async ({ page, isMobile }) => {
  await fixture(page, "merchant");
  await page.goto("/");
  if (isMobile) {
    const toggle = page.getByRole("button", { name: "Open navigation" });
    await expect(toggle).toHaveAttribute("aria-expanded", "false");
    await expect(page.getByRole("navigation", { name: "Merchant navigation" })).toBeHidden();
    await toggle.click();
    await expect(page.getByRole("button", { name: "Close navigation" })).toHaveAttribute("aria-expanded", "true");
    await capture(page, "mobile-navigation");
  }
  const navigation = page.getByRole("navigation", { name: "Merchant navigation" });
  await expect(navigation.getByRole("link", { name: "Overview" })).toHaveAttribute("aria-current", "page");
  await navigation.getByRole("link", { name: "Plans", exact: true }).click();
  await expect(page).toHaveURL(/merchant\/plans$/);
  if (isMobile) await page.getByRole("button", { name: "Open navigation" }).click();
  await expect(navigation.getByRole("link", { name: "Plans", exact: true })).toHaveAttribute("aria-current", "page");
  const skip = page.getByRole("link", { name: "Skip to content" });
  await skip.focus();
  await expect(skip).toBeInViewport();
  await page.keyboard.press("Enter");
  await expect(page).toHaveURL(/#main-content$/);
  await expect(page.locator("#main-content")).toBeFocused();
  await page.goto("/guide");
  await capture(page, "guide");
  if (!isMobile) {
    await page.setViewportSize({ width: 900, height: 900 });
    await page.goto("/");
    await capture(page, "overview-tablet");
    await page.setViewportSize({ width: 320, height: 800 });
    await capture(page, "overview-small");
  }
});
