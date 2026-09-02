// Client for the official external surface /openapi/v1 (device-token auth).
// Stable + typed surface: apps list/describe, run/stop, task events, DSL,
// workspaces. See PRD section 7.3.

import { apiCall, readSse, type RequestOpts } from "../core/http.ts";
import type { Result } from "../core/contract.ts";
import { isFilePayload, toFormData } from "../core/multipart.ts";

export class OpenapiClient {
  base: string;
  token: string;
  constructor(base: string, token: string) {
    this.base = base;
    this.token = token;
  }

  private call<T = unknown>(path: string, opts: RequestOpts = {}): Promise<Result<T>> {
    return apiCall<T>(`${this.base}/openapi/v1`, path, { ...opts, token: this.token });
  }

  listApps(q?: { page?: number; limit?: number; mode?: string; name?: string }): Promise<Result<unknown>> {
    return this.call("apps", { query: { page: q?.page, limit: q?.limit, mode: q?.mode, name: q?.name } });
  }

  getApp(appId: string): Promise<Result<unknown>> {
    return this.call(`apps/${appId}`);
  }

  runApp(appId: string, inputs: Record<string, unknown>): Promise<Result<unknown[]>> {
    return readSse(`${this.base}/openapi/v1`, `apps/${appId}:run`, { token: this.token, body: { inputs } });
  }

  stopTask(appId: string, taskId: string): Promise<Result<unknown>> {
    return this.call(`apps/${appId}/tasks/${taskId}:stop`, { method: "POST" });
  }

  taskEvents(appId: string, taskId: string): Promise<Result<unknown[]>> {
    return readSse(`${this.base}/openapi/v1`, `apps/${appId}/tasks/${taskId}/events`, { token: this.token });
  }

  exportDsl(appId: string, includeSecret = false): Promise<Result<string>> {
    return this.call<string>(`apps/${appId}/dsl`, {
      raw: true,
      query: { include_secret: includeSecret ? "true" : "false" },
    });
  }

  uploadFile(appId: string, body: Record<string, unknown>): Promise<Result<unknown>> {
    const payload = isFilePayload(body) ? toFormData(body) : body;
    return this.call(`apps/${appId}/files`, { body: payload });
  }

  importDsl(workspaceId: string, payload: Record<string, unknown>): Promise<Result<unknown>> {
    return this.call(`workspaces/${workspaceId}/apps/imports`, { body: payload });
  }

  confirmImport(workspaceId: string, importId: string): Promise<Result<unknown>> {
    return this.call(`workspaces/${workspaceId}/apps/imports/${importId}:confirm`, { method: "POST" });
  }

  checkDependencies(appId: string): Promise<Result<unknown>> {
    return this.call(`apps/${appId}/dependencies:check`, { method: "POST" });
  }

  listWorkspaces(): Promise<Result<unknown>> {
    return this.call("workspaces");
  }

  getWorkspace(workspaceId: string): Promise<Result<unknown>> {
    return this.call(`workspaces/${workspaceId}`);
  }
  switchWorkspace(workspaceId: string): Promise<Result<unknown>> {
    return this.call(`workspaces/${workspaceId}:switch`, { method: "POST" });
  }
  listMembers(workspaceId: string): Promise<Result<unknown>> {
    return this.call(`workspaces/${workspaceId}/members`);
  }
  hitlFormGet(appId: string, formToken: string): Promise<Result<unknown>> {
    return this.call(`apps/${appId}/human-input-forms/${formToken}`);
  }
  hitlFormSubmit(appId: string, formToken: string, body: Record<string, unknown>): Promise<Result<unknown>> {
    return this.call(`apps/${appId}/human-input-forms/${formToken}:submit`, { body });
  }

}
