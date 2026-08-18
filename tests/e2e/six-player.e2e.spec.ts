import { expect, test, type BrowserContext, type Page } from "@playwright/test";

const scenarioBySeat = [
  "own-turn",
  "single-target",
  "multi-target",
  "bingxin-response",
  "multi-dying",
  "waiting",
] as const;

interface Diagnostics {
  console: string[];
  failedRequests: string[];
}

function captureDiagnostics(page: Page): Diagnostics {
  const diagnostics: Diagnostics = { console: [], failedRequests: [] };
  page.on("console", (message) => {
    if (message.type() === "error" || message.type() === "warning") {
      diagnostics.console.push(`${message.type()}:${message.text()}`);
    }
  });
  page.on("requestfailed", (request) => {
    diagnostics.failedRequests.push(
      `${request.method()} ${request.url()}: ${request.failure()?.errorText ?? "unknown"}`,
    );
  });
  return diagnostics;
}

test("six isolated BrowserContexts can operate private scenario surfaces", async ({
  browser,
  baseURL,
}) => {
  const contexts: BrowserContext[] = [];
  const diagnostics: Diagnostics[] = [];
  try {
    for (let index = 0; index < 6; index += 1) {
      const context = await browser.newContext({
        viewport: { width: 1366, height: 768 },
      });
      contexts.push(context);
      const page = await context.newPage();
      diagnostics.push(captureDiagnostics(page));
      await page.goto(baseURL!);
      await page.evaluate(
        (seat) => localStorage.setItem("verification-seat", seat),
        `p${index + 1}`,
      );
      await page
        .getByLabel("原型场景", { exact: true })
        .selectOption(scenarioBySeat[index]!);
      await expect(page.locator("h1")).not.toBeEmpty();
      await expect(page.locator("body")).toHaveCSS("overflow-x", "hidden");
    }

    const storedSeats = await Promise.all(
      contexts.map(async (context) => {
        const [page] = context.pages();
        return page!.evaluate(() => localStorage.getItem("verification-seat"));
      }),
    );
    expect(storedSeats).toEqual(["p1", "p2", "p3", "p4", "p5", "p6"]);

    const bingxinPage = contexts[3]!.pages()[0]!;
    await bingxinPage.getByRole("button", { name: /冰心诀/ }).click();
    await expect(
      bingxinPage.getByRole("button", { name: "确认提交" }),
    ).toBeEnabled();
    await bingxinPage.getByRole("button", { name: "确认提交" }).click();
    await expect(bingxinPage.getByRole("status")).toContainText("使用冰心诀");

    const dyingPage = contexts[4]!.pages()[0]!;
    await dyingPage.getByRole("button", { name: /妙手回春/ }).click();
    await dyingPage.getByRole("button", { name: "景天，可选目标" }).click();
    await expect(
      dyingPage.getByRole("button", { name: "确认提交" }),
    ).toBeEnabled();

    for (const entry of diagnostics) {
      expect(entry.console).toEqual([]);
      expect(entry.failedRequests).toEqual([]);
    }
  } finally {
    await Promise.all(contexts.map((context) => context.close()));
  }
});

test("one visible player and five strategy bots complete the room journey", async ({
  page,
  baseURL,
}) => {
  const diagnostics = captureDiagnostics(page);
  await page.goto(`${baseURL}/?journey=room`);
  await page.getByRole("button", { name: "创建六人房间" }).click();
  await expect(page.getByLabel("六个座位").locator("article")).toHaveCount(6);
  await expect(page.locator(".journey-seat.is-bot")).toHaveCount(5);
  await page.getByRole("button", { name: "坐入 1 席" }).click();
  await page.getByRole("button", { name: "准备", exact: true }).click();
  await expect(page.locator(".journey-seat.is-ready")).toHaveCount(6);
  await page.getByRole("button", { name: "选择李逍遥并开始" }).click();
  await expect(
    page.getByRole("heading", { name: "六人已准备，可以进入对局" }),
  ).toBeVisible();
  expect(diagnostics.console).toEqual([]);
  expect(diagnostics.failedRequests).toEqual([]);
});

test("mobile keeps timeout, reconnect, expired, and rescue controls reachable", async ({
  browser,
  baseURL,
}) => {
  const context = await browser.newContext({
    viewport: { width: 360, height: 800 },
    isMobile: true,
    hasTouch: true,
  });
  const page = await context.newPage();
  const diagnostics = captureDiagnostics(page);
  try {
    await page.goto(baseURL!);
    for (const scenario of [
      "disconnected",
      "reconnecting",
      "expired-action",
    ] as const) {
      await page.getByLabel("原型场景", { exact: true }).selectOption(scenario);
      await expect(page.locator(".action-tray")).toBeInViewport();
      await expect(page.locator("body")).toHaveJSProperty("scrollWidth", 360);
    }

    await page
      .getByLabel("原型场景", { exact: true })
      .selectOption("multi-dying");
    await page.getByRole("button", { name: /妙手回春/ }).click();
    await page.getByRole("button", { name: "景天，可选目标" }).click();
    const confirm = page.getByRole("button", { name: "确认提交" });
    await expect(confirm).toBeInViewport();
    await expect(confirm).toBeEnabled();
    const box = await confirm.boundingBox();
    expect(box?.width).toBeGreaterThanOrEqual(44);
    expect(box?.height).toBeGreaterThanOrEqual(44);
    expect(diagnostics.console).toEqual([]);
    expect(diagnostics.failedRequests).toEqual([]);
  } finally {
    await context.close();
  }
});
