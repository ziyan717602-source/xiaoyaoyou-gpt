import { copyFileSync, mkdirSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import type { Reporter, TestCase, TestResult } from "@playwright/test/reporter";

function safeName(value: string): string {
  return value
    .replaceAll(/[^a-z0-9_-]+/giu, "-")
    .replaceAll(/^-|-$/gu, "")
    .slice(0, 100);
}

export default class PersistentFailureReporter implements Reporter {
  onTestEnd(test: TestCase, result: TestResult): void {
    if (result.status === test.expectedStatus) return;
    const directory = join(
      "artifacts",
      "failures",
      "p07-e2e",
      `${safeName(test.titlePath().join("-"))}-retry-${result.retry}`,
    );
    mkdirSync(directory, { recursive: true });
    writeFileSync(
      join(directory, "failure.json"),
      `${JSON.stringify({ titlePath: test.titlePath(), expectedStatus: test.expectedStatus, actualStatus: result.status, retry: result.retry, durationMs: result.duration, errors: result.errors.map((error) => error.message) }, null, 2)}\n`,
    );
    for (const attachment of result.attachments) {
      if (attachment.path !== undefined) {
        copyFileSync(
          attachment.path,
          join(directory, basename(attachment.path)),
        );
      }
    }
  }
}
