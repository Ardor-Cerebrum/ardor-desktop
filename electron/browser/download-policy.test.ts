import { describe, expect, test } from "bun:test";

import { forceInlinePdfDownload } from "./download-policy";

describe("browser download policy", () => {
  test("forces an inline main-frame PDF into a native download", () => {
    expect(
      forceInlinePdfDownload("mainFrame", {
        "Content-Type": ["application/pdf; charset=binary"],
        "content-disposition": ['inline; filename="report.pdf"'],
        ETag: ["document-version"],
      }),
    ).toEqual({
      "Content-Type": ["application/pdf; charset=binary"],
      "Content-Disposition": ['attachment; filename="report.pdf"'],
      ETag: ["document-version"],
    });
  });

  test("leaves attachments, subframes, and non-PDF responses unchanged", () => {
    expect(
      forceInlinePdfDownload("mainFrame", {
        "content-type": ["application/pdf"],
        "content-disposition": ["attachment; filename=report.pdf"],
      }),
    ).toBeUndefined();
    expect(forceInlinePdfDownload("subFrame", { "content-type": ["application/pdf"] })).toBeUndefined();
    expect(forceInlinePdfDownload("mainFrame", { "content-type": ["text/html"] })).toBeUndefined();
  });
});
