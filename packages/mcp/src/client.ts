/**
 * Arbitra REST API client: fetch-based HTTP client with Bearer token auth.
 */

/**
 * Structured error envelope emitted by arbitra backend writes. Shape:
 *   { error: { code, message, details } }
 *
 * Originally only `VALIDATION_ERROR` carried a structured body; arbitra PR
 * #356 expanded this surface to `MISSING_REQUIRED_EVIDENCE` and
 * `INVALID_CASE_STATE` as well. The discriminated union captures the known
 * shapes; the catch-all string-code variant keeps forward-compat with any
 * new codes the backend introduces.
 */
export type ArbitraStructuredError =
  | {
      code: "VALIDATION_ERROR";
      message: string;
      details: { issues: Array<{ path: string; message: string }> };
    }
  | {
      code: "MISSING_REQUIRED_EVIDENCE";
      message: string;
      details: { missing: string[] };
    }
  | {
      code: "INVALID_CASE_STATE";
      message: string;
      details: { current_status: string; required_status: string };
    }
  | { code: string; message: string; details?: unknown };

export class ArbitraApiError extends Error {
  public readonly code?: string;
  public readonly details?: unknown;

  constructor(
    public readonly status: number,
    message: string,
    options?: { code?: string; details?: unknown }
  ) {
    super(`Arbitra API error (${status}): ${message}`);
    this.name = "ArbitraApiError";
    if (options?.code !== undefined) this.code = options.code;
    if (options?.details !== undefined) this.details = options.details;
  }
}

/**
 * Token provider — synchronous or async. The MCP server wires this to the
 * credentials chain so a token rotation (e.g. after a device-flow completes
 * mid-process) is reflected on the very next request without rebuilding the
 * client.
 */
export type TokenProvider = () => string | Promise<string>;

export class ArbitraClient {
  private getToken: TokenProvider;

  constructor(
    private baseUrl: string,
    tokenOrProvider: string | TokenProvider,
    private timeoutMs = 10000
  ) {
    this.getToken =
      typeof tokenOrProvider === "function"
        ? (tokenOrProvider as TokenProvider)
        : () => tokenOrProvider;
  }

  setBaseUrl(baseUrl: string): void {
    this.baseUrl = baseUrl;
  }

  setTokenProvider(provider: TokenProvider): void {
    this.getToken = provider;
  }

  private async headers(hasBody: boolean): Promise<Record<string, string>> {
    const token = await this.getToken();
    const h: Record<string, string> = {
      Authorization: `Bearer ${token}`,
      Accept: "application/json",
    };
    if (hasBody) {
      h["Content-Type"] = "application/json";
    }
    return h;
  }

  private buildUrl(path: string, params?: Record<string, string>): string {
    const url = new URL(path, this.baseUrl);
    if (params) {
      for (const [k, v] of Object.entries(params)) {
        if (v !== undefined && v !== "") {
          url.searchParams.set(k, v);
        }
      }
    }
    return url.toString();
  }

  private async parseResponseBody(res: Response): Promise<unknown> {
    if (res.status === 204) {
      return null;
    }

    const contentType = res.headers.get("content-type") || "";
    const raw = await res.text();

    if (!raw.trim()) {
      return null;
    }

    if (contentType.includes("application/json")) {
      return JSON.parse(raw) as unknown;
    }

    return raw;
  }

  private async handleResponse<T>(res: Response): Promise<T> {
    const body = await this.parseResponseBody(res);

    if (!res.ok) {
      if (body && typeof body === "object") {
        const errorBody = body as Record<string, unknown>;
        const errorField = errorBody.error;

        // Structured envelope: { error: { code, message, details } }.
        // Backend emits this for VALIDATION_ERROR, MISSING_REQUIRED_EVIDENCE,
        // INVALID_CASE_STATE, and other ArbitraError subclasses.
        if (errorField && typeof errorField === "object" && !Array.isArray(errorField)) {
          const structured = errorField as Record<string, unknown>;
          const code =
            typeof structured.code === "string" ? structured.code : undefined;
          const message =
            typeof structured.message === "string"
              ? structured.message
              : JSON.stringify(structured);
          const details = structured.details;
          throw new ArbitraApiError(res.status, message, { code, details });
        }

        // Legacy flat string envelope: { error: "forbidden" }.
        if (typeof errorField === "string") {
          throw new ArbitraApiError(res.status, errorField);
        }

        // Last-resort fallbacks: top-level message, then full-body stringify.
        const fallback =
          (typeof errorBody.message === "string" ? errorBody.message : undefined) ||
          JSON.stringify(errorBody);
        throw new ArbitraApiError(res.status, fallback);
      }

      throw new ArbitraApiError(res.status, String(body ?? res.statusText));
    }

    return body as T;
  }

  private async request<T>(
    method: "GET" | "POST" | "PATCH",
    path: string,
    options?: {
      params?: Record<string, string>;
      body?: unknown;
    }
  ): Promise<T> {
    const url = this.buildUrl(path, options?.params);
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.timeoutMs);

    try {
      const res = await fetch(url, {
        method,
        headers: await this.headers(options?.body !== undefined),
        body:
          options?.body !== undefined ? JSON.stringify(options.body) : undefined,
        signal: controller.signal,
      });
      return await this.handleResponse<T>(res);
    } catch (error) {
      if (error instanceof ArbitraApiError) {
        throw error;
      }

      if (error instanceof Error && error.name === "AbortError") {
        throw new Error(
          `Request timed out after ${this.timeoutMs}ms: ${method} ${path}`
        );
      }

      if (error instanceof Error) {
        throw new Error(
          error.message || `Request failed for ${method} ${path}`,
          { cause: error }
        );
      }

      throw error;
    } finally {
      clearTimeout(timeout);
    }
  }

  async get<T>(path: string, params?: Record<string, string>): Promise<T> {
    return this.request<T>("GET", path, { params });
  }

  async post<T>(path: string, body?: unknown): Promise<T> {
    return this.request<T>("POST", path, { body });
  }

  async patch<T>(path: string, body: unknown): Promise<T> {
    return this.request<T>("PATCH", path, { body });
  }
}
