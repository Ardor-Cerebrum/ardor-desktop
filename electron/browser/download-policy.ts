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
    const value = values[0] ?? "";
    if (name.toLowerCase() === "content-type") {
      contentType = value.toLowerCase();
    } else if (name.toLowerCase() === "content-disposition") {
      disposition = value.toLowerCase().trimStart();
      const separator = value.indexOf(";");
      suffix = separator === -1 ? "" : value.slice(separator);
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
