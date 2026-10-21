export function extractCaseIdFromResourceUri(uri: URL): string {
  const pathSegments = uri.pathname.split("/").filter(Boolean);

  if (uri.host === "case") {
    const caseId = pathSegments[0];
    if (!caseId) {
      throw new Error(`Invalid case resource URI: ${uri.href}`);
    }
    return caseId;
  }

  const caseIndex = pathSegments.indexOf("case");
  const caseId = caseIndex >= 0 ? pathSegments[caseIndex + 1] : undefined;
  if (!caseId) {
    throw new Error(`Invalid case resource URI: ${uri.href}`);
  }

  return caseId;
}
