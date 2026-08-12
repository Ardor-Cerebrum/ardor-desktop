const ATTACHMENT_HEADER = "Content-Disposition";

export function forceInlinePdfDownload(
  resourceType: string,
  responseHeaders: Record<string, string[]> | undefined,
): Record<string, string[]> | undefined {
  if (resourceType !== "mainFrame") return undefined;

  let contentType = "";
  let disposition = "";
  let suffix = "";
  for (const [name, values] of Object.entries(responseHeaders ?? {})) {
    if (name.toLowerCase() === "content-type") {
      contentType = (values[0] ?? "").toLowerCase();
    } else if (name.toLowerCase() === "content-disposition") {
      disposition = (values[0] ?? "").toLowerCase().trimStart();
      const separator = (values[0] ?? "").indexOf(";");
      suffix = separator === -1 ? "" : (values[0] ?? "").slice(separator);
    }
  }
  if (!contentType.startsWith("application/pdf") || disposition.startsWith("attachment")) {
    return undefined;
  }

  const rewritten: Record<string, string[]> = {};
  for (const [name, values] of Object.entries(responseHeaders ?? {})) {
    if (name.toLowerCase() !== "content-disposition") rewritten[name] = values;
  }
  rewritten[ATTACHMENT_HEADER] = [`attachment${suffix}`];
  return rewritten;
}
