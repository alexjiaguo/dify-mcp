// Client for the internal Console API /console/api. Authoring-only surface:
// app create/update/delete, draft sync, node defaults, publish, node runs,
// providers/plugins. Hand-typed; version adaptation lives here.

import { apiCall, readSse, type RequestOpts } from "../core/http.ts";
import { ok, err, type Result } from "../core/contract.ts";
import { isFilePayload, toFormData } from "../core/multipart.ts";

export class ConsoleClient {
  base: string;
  token?: string;
  cookies?: Record<string, string>;
  onRefresh?: (cookies: Record<string, string>) => Promise<Record<string, string> | null>;
  constructor(
    base: string,
    token?: string,
    cookies?: Record<string, string>,
    onRefresh?: (cookies: Record<string, string>) => Promise<Record<string, string> | null>,
  ) {
    this.base = base;
    this.token = token;
    this.cookies = cookies;
    this.onRefresh = onRefresh;
  }

  // Cookie-auth (current Dify console) takes precedence; Bearer is the fallback
  // for the console OAuth-server surface or older token-based setups.
  private authOpts(opts: RequestOpts): RequestOpts {
    if (this.cookies && Object.keys(this.cookies).length) {
      const csrfKey = Object.keys(this.cookies).find((k) => /csrf/i.test(k));
      return { ...opts, cookies: this.cookies, csrfToken: csrfKey ? this.cookies[csrfKey] : undefined };
    }
    if (this.token) return { ...opts, token: this.token };
    return opts;
  }

  private async call<T = unknown>(path: string, opts: RequestOpts = {}): Promise<Result<T>> {
    let res = await apiCall<T>(`${this.base}/console/api`, path, this.authOpts(opts));
    if (!res.ok && res.error.code === "AUTH_EXPIRED" && this.cookies && this.onRefresh) {
      const refreshed = await this.onRefresh(this.cookies);
      if (refreshed) {
        this.cookies = refreshed;
        res = await apiCall<T>(`${this.base}/console/api`, path, this.authOpts(opts));
      }
    }
    return res;
  }

  private async stream(path: string, opts: RequestOpts = {}): Promise<Result<unknown[]>> {
    let res = await readSse(`${this.base}/console/api`, path, this.authOpts(opts));
    if (!res.ok && res.error.code === "AUTH_EXPIRED" && this.cookies && this.onRefresh) {
      const refreshed = await this.onRefresh(this.cookies);
      if (refreshed) {
        this.cookies = refreshed;
        res = await readSse(`${this.base}/console/api`, path, this.authOpts(opts));
      }
    }
    return res;
  }

  // --- apps ---
  listApps(q?: { page?: number; limit?: number; mode?: string; name?: string }): Promise<Result<unknown>> {
    return this.call("apps", { query: { page: q?.page, limit: q?.limit, mode: q?.mode, name: q?.name } });
  }
  getApp(appId: string): Promise<Result<unknown>> {
    return this.call(`apps/${appId}`);
  }
  async exportDsl(appId: string, includeSecret = false): Promise<Result<string>> {
    const r = await this.call<{ data: string }>(`apps/${appId}/export`, {
      query: { include_secret: includeSecret ? "true" : "false" },
    });
    return r.ok ? ok(r.data.data) : r;
  }
  importDsl(payload: Record<string, unknown>): Promise<Result<unknown>> {
    return this.call("apps/imports", { body: payload });
  }
  confirmImport(importId: string): Promise<Result<unknown>> {
    return this.call(`apps/imports/${importId}/confirm`, { body: {} });
  }
  createApp(body: Record<string, unknown>): Promise<Result<unknown>> {
    return this.call("apps", { body });
  }
  updateApp(appId: string, body: Record<string, unknown>): Promise<Result<unknown>> {
    return this.call(`apps/${appId}`, { method: "PUT", body });
  }
  deleteApp(appId: string): Promise<Result<unknown>> {
    return this.call(`apps/${appId}`, { method: "DELETE" });
  }
  async getAppTags(appId: string): Promise<Result<{ app_id: string; tags: Array<{ id?: string; name: string }> }>> {
    const app = await this.getApp(appId);
    if (!app.ok) return app;
    const raw = (app.data as Record<string, unknown>).tags;
    const tags = Array.isArray(raw)
      ? raw.flatMap((item) => {
          if (!item || typeof item !== "object") return [];
          const value = item as Record<string, unknown>;
          const name = nonEmptyString(value.name);
          if (!name) return [];
          const id = nonEmptyString(value.id);
          return [{ ...(id ? { id } : {}), name }];
        })
      : [];
    return ok({ app_id: appId, tags });
  }
  listAppTags(): Promise<Result<unknown>> {
    return this.call("tags", { query: { type: "app" } });
  }
  createAppTag(name: string): Promise<Result<unknown>> {
    return this.call("tags", { body: { name, type: "app" } });
  }
  bindAppTag(appId: string, tagId: string): Promise<Result<unknown>> {
    return this.call("tag-bindings", {
      body: { tag_ids: [tagId], target_id: appId, type: "app" },
    });
  }
  removeAppTagBinding(appId: string, tagId: string): Promise<Result<unknown>> {
    return this.call("tag-bindings/remove", {
      body: { tag_ids: [tagId], target_id: appId, type: "app" },
    });
  }
  async ensureAppTag(appId: string, tagName: string): Promise<Result<unknown>> {
    const before = await this.getAppTags(appId);
    if (!before.ok) return before;
    const existing = before.data.tags.find((tag) => tag.name === tagName);
    if (existing) {
      return ok({ action: "unchanged", app_id: appId, tag: existing, after: before.data.tags });
    }

    const listed = await this.listAppTags();
    if (!listed.ok) return listed;
    const rows = asList(listed.data);
    let tagId: string | undefined;
    for (const item of rows) {
      if (!item || typeof item !== "object") continue;
      const value = item as Record<string, unknown>;
      if (value.name === tagName) tagId = nonEmptyString(value.id);
    }
    let created = false;
    if (!tagId) {
      const added = await this.createAppTag(tagName);
      if (!added.ok) return added;
      tagId = nonEmptyString((added.data as Record<string, unknown> | null)?.id);
      if (!tagId) return err("SERVER_ERROR", "created app tag response is missing id");
      created = true;
    }

    const bound = await this.bindAppTag(appId, tagId);
    if (!bound.ok) return bound;
    const after = await this.getAppTags(appId);
    if (!after.ok) return after;
    const readback = after.data.tags.find((tag) => tag.name === tagName);
    if (!readback) {
      return err("SERVER_ERROR", `app tag ${tagName} is missing after bind readback`, {
        details: { app_id: appId, tag_id: tagId, after: after.data.tags },
      });
    }
    return ok({
      action: created ? "created_and_bound" : "bound",
      app_id: appId,
      tag: readback,
      after: after.data.tags,
    });
  }
  async removeAppTag(appId: string, tagName: string): Promise<Result<unknown>> {
    const before = await this.getAppTags(appId);
    if (!before.ok) return before;
    const existing = before.data.tags.find((tag) => tag.name === tagName);
    if (!existing) {
      return ok({ action: "unchanged", app_id: appId, tag: tagName, after: before.data.tags });
    }

    let tagId = existing.id;
    if (!tagId) {
      const listed = await this.listAppTags();
      if (!listed.ok) return listed;
      const rows = asList(listed.data);
      for (const item of rows) {
        if (!item || typeof item !== "object") continue;
        const value = item as Record<string, unknown>;
        if (value.name === tagName) tagId = nonEmptyString(value.id);
      }
    }
    if (!tagId) return err("SERVER_ERROR", `app tag ${tagName} has no resolvable id`);

    const removed = await this.removeAppTagBinding(appId, tagId);
    if (!removed.ok) return removed;
    const after = await this.getAppTags(appId);
    if (!after.ok) return after;
    if (after.data.tags.some((tag) => tag.name === tagName)) {
      return err("SERVER_ERROR", `app tag ${tagName} remains after unbind readback`, {
        details: { app_id: appId, tag_id: tagId, after: after.data.tags },
      });
    }
    return ok({
      action: "removed",
      app_id: appId,
      tag: { id: tagId, name: tagName },
      after: after.data.tags,
    });
  }

  // --- workspaces ---
  listWorkspaces(): Promise<Result<unknown>> {
    return this.call("workspaces");
  }
  getWorkspace(workspaceId?: string): Promise<Result<unknown>> {
    return this.call(workspaceId ? `workspaces/${workspaceId}` : "workspaces/current");
  }
  switchWorkspace(workspaceId: string): Promise<Result<unknown>> {
    return this.call("workspaces/switch", { body: { tenant_id: workspaceId } });
  }
  listMembers(workspaceId?: string): Promise<Result<unknown>> {
    return this.call(workspaceId ? `workspaces/${workspaceId}/members` : "workspaces/current/members");
  }
  checkDependencies(appId: string): Promise<Result<unknown>> {
    return this.call(`apps/${appId}/dependencies`, { method: "POST" });
  }
  uploadFile(file: Record<string, unknown>): Promise<Result<unknown>> {
    const body = isFilePayload(file) ? toFormData(file) : file;
    return this.call("files/upload", { body });
  }

  // --- workflow authoring ---
  getDraft(appId: string): Promise<Result<unknown>> {
    return this.call(`apps/${appId}/workflows/draft`);
  }
  syncDraft(appId: string, body: Record<string, unknown>): Promise<Result<unknown>> {
    return this.call(`apps/${appId}/workflows/draft`, { body });
  }
  nodeDefaults(appId: string, nodeType?: string): Promise<Result<unknown>> {
    return this.call(
      `apps/${appId}/workflows/default-workflow-block-configs${nodeType ? `/${nodeType}` : ""}`,
    );
  }
  publish(appId: string, body: Record<string, unknown>): Promise<Result<unknown>> {
    return this.call(`apps/${appId}/workflows/publish`, { body });
  }

  // --- workflow-as-tool providers ---
  async getWorkflowTool(q: { appId?: string; toolId?: string }): Promise<Result<Record<string, unknown>>> {
    const result = await this.call<Record<string, unknown>>("workspaces/current/tool-provider/workflow/get", {
      query: { workflow_app_id: q.appId, workflow_tool_id: q.toolId },
    });
    // Dify versions have returned both 404 and 400/500 + "Tool not found" for
    // this lookup. Normalize all of them to the stable NOT_FOUND contract.
    if (!result.ok && /tool not found/i.test(result.error.message)) {
      return err("NOT_FOUND", result.error.message, { details: result.error.details });
    }
    return result;
  }
  createWorkflowTool(body: Record<string, unknown>): Promise<Result<unknown>> {
    return this.call("workspaces/current/tool-provider/workflow/create", { body });
  }
  updateWorkflowTool(body: Record<string, unknown>): Promise<Result<unknown>> {
    return this.call("workspaces/current/tool-provider/workflow/update", { body });
  }
  deleteWorkflowTool(toolId: string): Promise<Result<unknown>> {
    return this.call("workspaces/current/tool-provider/workflow/delete", {
      body: { workflow_tool_id: toolId },
    });
  }
  async refreshWorkflowToolProvider(appId: string): Promise<Result<unknown>> {
    const current = await this.getWorkflowTool({ appId });
    if (!current.ok && current.error.code !== "NOT_FOUND") return current;
    if (current.ok && current.data.synced === true) {
      return ok({ action: "unchanged", before: current.data, after: current.data });
    }

    const [app, draft] = await Promise.all([this.getApp(appId), this.getDraft(appId)]);
    if (!app.ok) return app;
    if (!draft.ok) return draft;
    const existing = current.ok ? current.data : undefined;
    const body = buildWorkflowToolPayload(
      app.data as Record<string, unknown>,
      draft.data as Record<string, unknown>,
      existing,
    );

    let mutation: Result<unknown>;
    let action: "created" | "updated";
    if (existing) {
      const toolId = nonEmptyString(existing.workflow_tool_id);
      if (!toolId) return err("SERVER_ERROR", "workflow tool detail is missing workflow_tool_id");
      action = "updated";
      mutation = await this.updateWorkflowTool({ ...body, workflow_tool_id: toolId });
    } else {
      action = "created";
      mutation = await this.createWorkflowTool({ ...body, workflow_app_id: appId });
    }
    if (!mutation.ok) return mutation;

    const after = await this.getWorkflowTool({ appId });
    if (!after.ok) return after;
    if (after.data.synced !== true) {
      return err("SERVER_ERROR", `workflow tool provider for app ${appId} is still out of sync`, {
        details: { action, before: existing ?? null, after: after.data },
      });
    }
    return ok({ action, before: existing ?? null, after: after.data });
  }

  // --- testing ---
  runDraft(appId: string, inputs: Record<string, unknown>): Promise<Result<unknown[]>> {
    return this.stream(`apps/${appId}/workflows/draft/run`, { body: { inputs } });
  }
  runPublished(appId: string, inputs: Record<string, unknown>): Promise<Result<unknown[]>> {
    return this.stream(`apps/${appId}/workflows/run`, { body: { inputs } });
  }
  stopTask(appId: string, taskId: string): Promise<Result<unknown>> {
    return this.call(`apps/${appId}/workflow-runs/tasks/${taskId}/stop`, { method: "POST" });
  }
  nodeLastRun(appId: string, nodeId: string): Promise<Result<unknown>> {
    return this.call(`apps/${appId}/workflows/draft/nodes/${nodeId}/last-run`);
  }
  chatMessages(appId: string, body: Record<string, unknown>): Promise<Result<unknown[]>> {
    return this.stream(`apps/${appId}/chat-messages`, { body });
  }
  completionMessages(appId: string, body: Record<string, unknown>): Promise<Result<unknown[]>> {
    return this.stream(`apps/${appId}/completion-messages`, { body });
  }
  runNode(
    appId: string,
    nodeId: string,
    inputs: Record<string, unknown>,
    mode: "node" | "iteration" | "loop" = "node",
  ): Promise<Result<unknown>> {
    const path =
      mode === "node"
        ? `apps/${appId}/workflows/draft/nodes/${nodeId}/run`
        : `apps/${appId}/workflows/draft/${mode}/nodes/${nodeId}/run`;
    return this.call(path, { body: { inputs } });
  }

  // --- providers / plugins ---
  listProviders(): Promise<Result<unknown>> {
    return this.call("workspaces/current/model-providers");
  }
  providerModels(provider: string): Promise<Result<unknown>> {
    return this.call(`workspaces/current/model-providers/${provider}/models`);
  }
  setProviderCredentials(provider: string, credentials: Record<string, unknown>): Promise<Result<unknown>> {
    return this.call(`workspaces/current/model-providers/${provider}/credentials`, {
      body: { credentials },
    });
  }
  listPlugins(): Promise<Result<unknown>> {
    return this.call("workspaces/current/plugin/list");
  }
  getPlugin(pluginUniqueIdentifier: string): Promise<Result<unknown>> {
    return this.call("workspaces/current/plugin/fetch-manifest", {
      query: { plugin_unique_identifier: pluginUniqueIdentifier },
    });
  }
  installPlugins(identifiers: string[], source: "marketplace" | "pkg" = "marketplace"): Promise<Result<unknown>> {
    const path =
      source === "pkg"
        ? "workspaces/current/plugin/install/pkg"
        : "workspaces/current/plugin/install/marketplace";
    return this.call(path, { body: { plugin_unique_identifiers: identifiers } });
  }
  uninstallPlugin(pluginInstallationId: string): Promise<Result<unknown>> {
    return this.call("workspaces/current/plugin/uninstall", {
      body: { plugin_installation_id: pluginInstallationId },
    });
  }

  // --- features & variables ---
  async getFeatures(appId: string): Promise<Result<unknown>> {
    // The features endpoint is POST-only (update); reads come from the draft.
    const r = await this.call<{ features: unknown }>(`apps/${appId}/workflows/draft`);
    return r.ok ? ok(r.data.features) : r;
  }
  setFeatures(appId: string, features: Record<string, unknown>): Promise<Result<unknown>> {
    return this.call(`apps/${appId}/workflows/draft/features`, { body: { features } });
  }
  listEnvVars(appId: string): Promise<Result<unknown>> {
    return this.call(`apps/${appId}/workflows/draft/environment-variables`);
  }
  listConvVars(appId: string): Promise<Result<unknown>> {
    return this.call(`apps/${appId}/workflows/draft/conversation-variables`);
  }
  async createVariable(appId: string, body: Record<string, unknown>, variableType?: string): Promise<Result<unknown>> {
    // Dify replaces env/conversation variables as a full list (no single-create).
    const isConv = variableType === "conversation";
    const endpoint = isConv ? "conversation-variables" : "environment-variables";
    const listKey = isConv ? "conversation_variables" : "environment_variables";
    const current = await this.call(`apps/${appId}/workflows/draft/${endpoint}`);
    if (!current.ok) return current;
    const items = asList(current.data) as Record<string, unknown>[];
    return this.call(`apps/${appId}/workflows/draft/${endpoint}`, { body: { [listKey]: [...items, body] } });
  }
  updateVariable(appId: string, variableId: string, body: Record<string, unknown>): Promise<Result<unknown>> {
    return this.call(`apps/${appId}/workflows/draft/variables/${variableId}`, { method: "PUT", body });
  }
  deleteVariable(appId: string, variableId: string): Promise<Result<unknown>> {
    return this.call(`apps/${appId}/workflows/draft/variables/${variableId}`, { method: "DELETE" });
  }

  // --- versions ---
  listVersions(appId: string): Promise<Result<unknown>> {
    return this.call(`apps/${appId}/workflows`);
  }
  async getVersion(appId: string, workflowId: string): Promise<Result<unknown>> {
    // The /workflows/{id} endpoint is PATCH/DELETE only; read via the list and filter.
    const r = await this.listVersions(appId);
    if (!r.ok) return r;
    const items = ((r.data as Record<string, unknown>).items ?? (r.data as Record<string, unknown>).data ?? []) as Record<string, unknown>[];
    const found = items.find((v) => v.id === workflowId);
    if (!found) return err("NOT_FOUND", `workflow version ${workflowId} not found`);
    return ok(found);
  }
  restoreVersion(appId: string, workflowId: string): Promise<Result<unknown>> {
    return this.call(`apps/${appId}/workflows/${workflowId}/restore`, { method: "POST" });
  }
  deleteVersion(appId: string, workflowId: string): Promise<Result<unknown>> {
    return this.call(`apps/${appId}/workflows/${workflowId}`, { method: "DELETE" });
  }

  // --- app metadata ---
  copyApp(appId: string): Promise<Result<unknown>> {
    return this.call(`apps/${appId}/copy`, { method: "POST" });
  }
  renameApp(appId: string, name: string): Promise<Result<unknown>> {
    return this.call(`apps/${appId}/name`, { body: { name } });
  }
  setAppIcon(appId: string, body: Record<string, unknown>): Promise<Result<unknown>> {
    return this.call(`apps/${appId}/icon`, { body });
  }
  convertApp(appId: string, body: Record<string, unknown>): Promise<Result<unknown>> {
    return this.call(`apps/${appId}/convert-to-workflow`, { body });
  }

  // --- triggers ---
  listTriggers(appId: string): Promise<Result<unknown>> {
    return this.call(`apps/${appId}/triggers`);
  }
  createTrigger(appId: string, body: Record<string, unknown>): Promise<Result<unknown>> {
    return this.call(`apps/${appId}/triggers`, { body });
  }
  enableTrigger(appId: string, body: Record<string, unknown>): Promise<Result<unknown>> {
    return this.call(`apps/${appId}/trigger-enable`, { body });
  }
  webhookTrigger(appId: string): Promise<Result<unknown>> {
    return this.call(`apps/${appId}/workflows/triggers/webhook`);
  }
  triggerRun(appId: string, body: Record<string, unknown>): Promise<Result<unknown>> {
    return this.call(`apps/${appId}/workflows/draft/trigger/run`, { body });
  }
  triggerRunAll(appId: string, body: Record<string, unknown>): Promise<Result<unknown>> {
    return this.call(`apps/${appId}/workflows/draft/trigger/run-all`, { body });
  }

  // --- HITL ---
  hitlPreview(appId: string, nodeId: string, body: Record<string, unknown>): Promise<Result<unknown>> {
    return this.call(`apps/${appId}/workflows/draft/human-input/nodes/${nodeId}/form/preview`, { body });
  }
  hitlSubmit(appId: string, nodeId: string, body: Record<string, unknown>): Promise<Result<unknown>> {
    return this.call(`apps/${appId}/workflows/draft/human-input/nodes/${nodeId}/form/run`, { body });
  }

  // --- runs & stats ---
  listRuns(appId: string, q?: { page?: number; limit?: number; status?: string }): Promise<Result<unknown>> {
    return this.call(`apps/${appId}/workflow-runs`, { query: { page: q?.page, limit: q?.limit, status: q?.status } });
  }
  getRun(appId: string, runId: string): Promise<Result<unknown>> {
    return this.call(`apps/${appId}/workflow-runs/${runId}`);
  }
  runNodeExecutions(appId: string, runId: string): Promise<Result<unknown>> {
    return this.call(`apps/${appId}/workflow-runs/${runId}/node-executions`);
  }
  exportRun(appId: string, runId: string): Promise<Result<unknown>> {
    return this.call(`apps/${appId}/workflow-runs/${runId}/export`);
  }
  stats(appId: string, metric: string, q?: { start?: string; end?: string }): Promise<Result<unknown>> {
    // Dify expects "%Y-%m-%d %H:%M"; accept ISO dates and date-only strings too.
    const norm = (d?: string): string | undefined => {
      if (!d) return undefined;
      if (d.includes(" ")) return d;
      if (d.includes("T")) return d.replace("T", " ").slice(0, 16);
      return `${d} 00:00`;
    };
    return this.call(`apps/${appId}/workflow/statistics/${metric}`, { query: { start: norm(q?.start), end: norm(q?.end) } });
  }
  onlineUsers(q?: { page?: number; limit?: number }): Promise<Result<unknown>> {
    return this.call(`apps/workflows/online-users`, { query: { page: q?.page, limit: q?.limit } });
  }

  // --- comments ---
  listComments(appId: string): Promise<Result<unknown>> {
    return this.call(`apps/${appId}/workflow/comments`);
  }
  addComment(appId: string, body: Record<string, unknown>): Promise<Result<unknown>> {
    return this.call(`apps/${appId}/workflow/comments`, { body });
  }
  resolveComment(appId: string, commentId: string): Promise<Result<unknown>> {
    return this.call(`apps/${appId}/workflow/comments/${commentId}/resolve`, { method: "POST" });
  }

  // --- annotations ---
  listAnnotations(appId: string): Promise<Result<unknown>> {
    return this.call(`apps/${appId}/annotations`);
  }
  addAnnotation(appId: string, body: Record<string, unknown>): Promise<Result<unknown>> {
    return this.call(`apps/${appId}/annotations`, { body });
  }
  deleteAnnotation(appId: string, annotationId: string): Promise<Result<unknown>> {
    return this.call(`apps/${appId}/annotations/${annotationId}`, { method: "DELETE" });
  }

  // --- audio ---
  audioToText(appId: string, body: Record<string, unknown>): Promise<Result<unknown>> {
    return this.call(`apps/${appId}/audio-to-text`, {
      body: isFilePayload(body) ? toFormData(body) : body,
    });
  }
  textToAudio(appId: string, body: Record<string, unknown>): Promise<Result<unknown>> {
    return this.call(`apps/${appId}/text-to-audio`, { body });
  }
  listVoices(appId: string, language: string): Promise<Result<unknown>> {
    return this.call(`apps/${appId}/text-to-audio/voices`, { query: { language } });
  }

  // --- rag pipelines (read-only list) ---
  listRagDatasets(q?: { page?: number; limit?: number; keyword?: string }): Promise<Result<unknown>> {
    // /rag/pipeline/dataset is POST-only (import); datasets are listed via /datasets.
    return this.call("datasets", { query: { page: q?.page, limit: q?.limit, keyword: q?.keyword } });
  }
  listRagTemplates(): Promise<Result<unknown>> {
    return this.call(`rag/pipeline/templates`);
  }

  // --- explore (installed apps) ---
  runInstalledApp(installedAppId: string, body: Record<string, unknown>): Promise<Result<unknown>> {
    return this.call(`installed-apps/${installedAppId}/workflows/run`, { body });
  }
  stopInstalledApp(installedAppId: string, taskId: string): Promise<Result<unknown>> {
    return this.call(`installed-apps/${installedAppId}/workflows/tasks/${taskId}/stop`, { method: "POST" });
  }

  // --- run archives ---
  listRunArchives(q?: { page?: number; limit?: number }): Promise<Result<unknown>> {
    return this.call(`workflow-run-archives`, { query: { page: q?.page, limit: q?.limit } });
  }
  downloadRunArchive(body: Record<string, unknown>): Promise<Result<unknown>> {
    return this.call(`workflow-run-archives/downloads`, { body });
  }

  // --- annotations (completion: reply action, settings, export, batch import) ---
  annotationReplyAction(appId: string, action: string): Promise<Result<unknown>> {
    return this.call(`apps/${appId}/annotation-reply/${action}`, { method: "POST" });
  }
  annotationReplyStatus(appId: string, action: string, jobId: string): Promise<Result<unknown>> {
    return this.call(`apps/${appId}/annotation-reply/${action}/status/${jobId}`);
  }
  getAnnotationSetting(appId: string): Promise<Result<unknown>> {
    return this.call(`apps/${appId}/annotation-setting`);
  }
  updateAnnotationSetting(appId: string, settingId: string, body: Record<string, unknown>): Promise<Result<unknown>> {
    return this.call(`apps/${appId}/annotation-settings/${settingId}`, { body });
  }
  exportAnnotations(appId: string): Promise<Result<unknown>> {
    return this.call(`apps/${appId}/annotations/export`);
  }
  batchImportAnnotations(appId: string, body: Record<string, unknown>): Promise<Result<unknown>> {
    return this.call(`apps/${appId}/annotations/batch-import`, {
      body: isFilePayload(body) ? toFormData(body) : body,
    });
  }
  annotationImportStatus(appId: string, jobId: string): Promise<Result<unknown>> {
    return this.call(`apps/${appId}/annotations/batch-import-status/${jobId}`);
  }
  annotationHitHistories(appId: string, annotationId: string): Promise<Result<unknown>> {
    return this.call(`apps/${appId}/annotations/${annotationId}/hit-histories`);
  }

  // --- rag pipeline (full CRUD + authoring, pipeline_id-scoped) ---
  createRagDataset(body: Record<string, unknown>): Promise<Result<unknown>> {
    return this.call(`rag/pipeline/dataset`, { body });
  }
  createEmptyRagDataset(body: Record<string, unknown>): Promise<Result<unknown>> {
    return this.call(`rag/pipeline/empty-dataset`, { body });
  }
  getRagTemplate(templateId: string): Promise<Result<unknown>> {
    return this.call(`rag/pipeline/templates/${templateId}`);
  }
  getRagDraft(pipelineId: string): Promise<Result<unknown>> {
    return this.call(`rag/pipelines/${pipelineId}/workflows/draft`);
  }
  syncRagDraft(pipelineId: string, body: Record<string, unknown>): Promise<Result<unknown>> {
    return this.call(`rag/pipelines/${pipelineId}/workflows/draft`, { body });
  }
  ragNodeDefaults(pipelineId: string, blockType?: string): Promise<Result<unknown>> {
    return this.call(`rag/pipelines/${pipelineId}/workflows/default-workflow-block-configs${blockType ? `/${blockType}` : ""}`);
  }
  runRagDraft(pipelineId: string, body: Record<string, unknown>): Promise<Result<unknown>> {
    return this.call(`rag/pipelines/${pipelineId}/workflows/draft/run`, { body });
  }
  runRagPublished(pipelineId: string, body: Record<string, unknown>): Promise<Result<unknown>> {
    return this.call(`rag/pipelines/${pipelineId}/workflows/published/run`, { body });
  }
  runRagNode(pipelineId: string, nodeId: string, body: Record<string, unknown>): Promise<Result<unknown>> {
    return this.call(`rag/pipelines/${pipelineId}/workflows/draft/nodes/${nodeId}/run`, { body });
  }
  stopRagTask(pipelineId: string, taskId: string): Promise<Result<unknown>> {
    return this.call(`rag/pipelines/${pipelineId}/workflow-runs/tasks/${taskId}/stop`, { method: "POST" });
  }
  publishRag(pipelineId: string, body: Record<string, unknown>): Promise<Result<unknown>> {
    return this.call(`rag/pipelines/${pipelineId}/workflows/publish`, { body });
  }
  listRagVersions(pipelineId: string): Promise<Result<unknown>> {
    return this.call(`rag/pipelines/${pipelineId}/workflows`);
  }
  getRagVersion(pipelineId: string, workflowId: string): Promise<Result<unknown>> {
    return this.call(`rag/pipelines/${pipelineId}/workflows/${workflowId}`);
  }
  updateRagVersion(pipelineId: string, workflowId: string, body: Record<string, unknown>): Promise<Result<unknown>> {
    return this.call(`rag/pipelines/${pipelineId}/workflows/${workflowId}`, { method: "PATCH", body });
  }
  restoreRagVersion(pipelineId: string, workflowId: string): Promise<Result<unknown>> {
    return this.call(`rag/pipelines/${pipelineId}/workflows/${workflowId}/restore`, { method: "POST" });
  }
  deleteRagVersion(pipelineId: string, workflowId: string): Promise<Result<unknown>> {
    return this.call(`rag/pipelines/${pipelineId}/workflows/${workflowId}`, { method: "DELETE" });
  }

  // --- customized snippets (workspace lifecycle + workflow authoring) ---
  listSnippets(q?: { page?: number; limit?: number; keyword?: string }): Promise<Result<unknown>> {
    return this.call(`workspaces/current/customized-snippets`, { query: { page: q?.page, limit: q?.limit, keyword: q?.keyword } });
  }
  createSnippet(body: Record<string, unknown>): Promise<Result<unknown>> {
    return this.call(`workspaces/current/customized-snippets`, { body });
  }
  getSnippet(snippetId: string): Promise<Result<unknown>> {
    return this.call(`workspaces/current/customized-snippets/${snippetId}`);
  }
  updateSnippet(snippetId: string, body: Record<string, unknown>): Promise<Result<unknown>> {
    return this.call(`workspaces/current/customized-snippets/${snippetId}`, { method: "PATCH", body });
  }
  deleteSnippet(snippetId: string): Promise<Result<unknown>> {
    return this.call(`workspaces/current/customized-snippets/${snippetId}`, { method: "DELETE" });
  }
  exportSnippet(snippetId: string): Promise<Result<unknown>> {
    return this.call(`workspaces/current/customized-snippets/${snippetId}/export`);
  }
  importSnippet(body: Record<string, unknown>): Promise<Result<unknown>> {
    return this.call(`workspaces/current/customized-snippets/imports`, { body });
  }
  confirmSnippetImport(importId: string): Promise<Result<unknown>> {
    return this.call(`workspaces/current/customized-snippets/imports/${importId}/confirm`, { method: "POST" });
  }
  checkSnippetDeps(snippetId: string): Promise<Result<unknown>> {
    return this.call(`workspaces/current/customized-snippets/${snippetId}/check-dependencies`);
  }
  getSnippetDraft(snippetId: string): Promise<Result<unknown>> {
    return this.call(`snippets/${snippetId}/workflows/draft`);
  }
  syncSnippetDraft(snippetId: string, body: Record<string, unknown>): Promise<Result<unknown>> {
    return this.call(`snippets/${snippetId}/workflows/draft`, { body });
  }
  snippetNodeDefaults(snippetId: string): Promise<Result<unknown>> {
    return this.call(`snippets/${snippetId}/workflows/default-workflow-block-configs`);
  }
  publishSnippet(snippetId: string, body: Record<string, unknown>): Promise<Result<unknown>> {
    return this.call(`snippets/${snippetId}/workflows/publish`, { body });
  }
  listSnippetVersions(snippetId: string): Promise<Result<unknown>> {
    return this.call(`snippets/${snippetId}/workflows`);
  }
  restoreSnippetVersion(snippetId: string, workflowId: string): Promise<Result<unknown>> {
    return this.call(`snippets/${snippetId}/workflows/${workflowId}/restore`, { method: "POST" });
  }
  updateSnippetVersion(snippetId: string, workflowId: string, body: Record<string, unknown>): Promise<Result<unknown>> {
    return this.call(`snippets/${snippetId}/workflows/${workflowId}`, { method: "PATCH", body });
  }
  runSnippetDraft(snippetId: string, body: Record<string, unknown>): Promise<Result<unknown>> {
    return this.call(`snippets/${snippetId}/workflows/draft/run`, { body });
  }
  runSnippetNode(snippetId: string, nodeId: string, body: Record<string, unknown>): Promise<Result<unknown>> {
    return this.call(`snippets/${snippetId}/workflows/draft/nodes/${nodeId}/run`, { body });
  }
  stopSnippetTask(snippetId: string, taskId: string): Promise<Result<unknown>> {
    return this.call(`snippets/${snippetId}/workflow-runs/tasks/${taskId}/stop`, { method: "POST" });
  }
  listSnippetRuns(snippetId: string, q?: { page?: number; limit?: number }): Promise<Result<unknown>> {
    return this.call(`snippets/${snippetId}/workflow-runs`, { query: { page: q?.page, limit: q?.limit } });
  }
  getSnippetRun(snippetId: string, runId: string): Promise<Result<unknown>> {
    return this.call(`snippets/${snippetId}/workflow-runs/${runId}`);
  }
  snippetRunNodeExecutions(snippetId: string, runId: string): Promise<Result<unknown>> {
    return this.call(`snippets/${snippetId}/workflow-runs/${runId}/node-executions`);
  }

  // --- agent config / drive / sandbox ---
  agentConfigManifest(appId: string): Promise<Result<unknown>> {
    return this.call(`apps/${appId}/agent/config/manifest`);
  }
  agentConfigSkills(appId: string): Promise<Result<unknown>> {
    return this.call(`apps/${appId}/agent/config/skills`);
  }
  agentConfigSkillUpload(appId: string, body: Record<string, unknown>): Promise<Result<unknown>> {
    return this.call(`apps/${appId}/agent/config/skills/upload`, {
      body: isFilePayload(body) ? toFormData(body) : body,
    });
  }
  agentConfigSkillInspect(appId: string, name: string): Promise<Result<unknown>> {
    return this.call(`apps/${appId}/agent/config/skills/${name}/inspect`);
  }
  agentConfigSkillPreview(appId: string, name: string): Promise<Result<unknown>> {
    return this.call(`apps/${appId}/agent/config/skills/${name}/files/preview`);
  }
  agentConfigFiles(appId: string): Promise<Result<unknown>> {
    return this.call(`apps/${appId}/agent/config/files`);
  }
  agentConfigFileUpload(appId: string, body: Record<string, unknown>): Promise<Result<unknown>> {
    return this.call(`apps/${appId}/agent/config/files`, {
      body: isFilePayload(body) ? toFormData(body) : body,
    });
  }
  agentDriveFiles(appId: string): Promise<Result<unknown>> {
    return this.call(`apps/${appId}/agent/drive/files`);
  }
  agentDriveSkills(appId: string): Promise<Result<unknown>> {
    return this.call(`apps/${appId}/agent/drive/skills`);
  }
  agentDriveSkillInspect(appId: string, skillPath: string): Promise<Result<unknown>> {
    return this.call(`apps/${appId}/agent/drive/skills/${skillPath}/inspect`);
  }
  agentDrivePreview(appId: string, params: Record<string, unknown>): Promise<Result<unknown>> {
    return this.call(`apps/${appId}/agent/drive/files/preview`, { query: params as Record<string, string | number | boolean | undefined> });
  }
  agentDriveDownload(appId: string, params: Record<string, unknown>): Promise<Result<unknown>> {
    return this.call(`apps/${appId}/agent/drive/files/download`, { query: params as Record<string, string | number | boolean | undefined> });
  }
  agentSandboxInfo(agentId: string): Promise<Result<unknown>> {
    return this.call(`agent/${agentId}/sandbox`);
  }
  agentSandboxFiles(agentId: string): Promise<Result<unknown>> {
    return this.call(`agent/${agentId}/sandbox/files`);
  }
  agentSandboxRead(agentId: string, params: Record<string, unknown>): Promise<Result<unknown>> {
    return this.call(`agent/${agentId}/sandbox/files/read`, { query: params as Record<string, string | number | boolean | undefined> });
  }
  agentSandboxUpload(agentId: string, body: Record<string, unknown>): Promise<Result<unknown>> {
    return this.call(`agent/${agentId}/sandbox/files/upload`, {
      body: isFilePayload(body) ? toFormData(body) : body,
    });
  }
}

function buildWorkflowToolPayload(
  app: Record<string, unknown>,
  draft: Record<string, unknown>,
  existing?: Record<string, unknown>,
): Record<string, unknown> {
  const appName = nonEmptyString(app.name) ?? "Workflow Tool";
  const label = nonEmptyString(existing?.label) ?? appName;
  const existingParameters = new Map<string, Record<string, unknown>>();
  if (Array.isArray(existing?.parameters)) {
    for (const item of existing.parameters) {
      if (!item || typeof item !== "object" || Array.isArray(item)) continue;
      const parameter = item as Record<string, unknown>;
      const name = nonEmptyString(parameter.name);
      if (name) existingParameters.set(name, parameter);
    }
  }

  return {
    name: nonEmptyString(existing?.name) ?? safeWorkflowToolName(label),
    label,
    description: typeof existing?.description === "string"
      ? existing.description
      : (typeof app.description === "string" ? app.description : ""),
    icon: workflowToolIcon(app, existing),
    parameters: workflowStartVariableNames(draft).map((name) => {
      const previous = existingParameters.get(name);
      return {
        name,
        description: typeof previous?.description === "string" ? previous.description : "",
        form: typeof previous?.form === "string" ? previous.form : "form",
      };
    }),
    labels: workflowToolLabels(existing),
    privacy_policy: typeof existing?.privacy_policy === "string" ? existing.privacy_policy : "",
  };
}

function workflowStartVariableNames(draft: Record<string, unknown>): string[] {
  const graph = draft.graph;
  if (!graph || typeof graph !== "object" || Array.isArray(graph)) return [];
  const nodes = (graph as Record<string, unknown>).nodes;
  if (!Array.isArray(nodes)) return [];
  for (const item of nodes) {
    if (!item || typeof item !== "object" || Array.isArray(item)) continue;
    const data = (item as Record<string, unknown>).data;
    if (!data || typeof data !== "object" || Array.isArray(data)) continue;
    const node = data as Record<string, unknown>;
    if (node.type !== "start" || !Array.isArray(node.variables)) continue;
    return node.variables
      .map((variable) => variable && typeof variable === "object" && !Array.isArray(variable)
        ? nonEmptyString((variable as Record<string, unknown>).variable)
          ?? nonEmptyString((variable as Record<string, unknown>).name)
        : undefined)
      .filter((name): name is string => Boolean(name));
  }
  return [];
}

function workflowToolIcon(
  app: Record<string, unknown>,
  existing?: Record<string, unknown>,
): Record<string, string> {
  if (existing?.icon && typeof existing.icon === "object" && !Array.isArray(existing.icon)) {
    return existing.icon as Record<string, string>;
  }
  return {
    content: nonEmptyString(app.icon) ?? "\ud83d\udd27",
    background: nonEmptyString(app.icon_background) ?? "#FFEAD5",
  };
}

function workflowToolLabels(existing?: Record<string, unknown>): string[] {
  const tool = existing?.tool;
  if (!tool || typeof tool !== "object" || Array.isArray(tool)) return [];
  const labels = (tool as Record<string, unknown>).labels;
  return Array.isArray(labels) ? labels.filter((label): label is string => typeof label === "string") : [];
}

function safeWorkflowToolName(label: string): string {
  let name = label.replace(/[^A-Za-z0-9_]+/g, "_").replace(/_{3,}/g, "_").replace(/^_+|_+$/g, "");
  if (!name) name = "workflow_tool";
  return /^\d/.test(name) ? `tool_${name}` : name;
}

function asList(data: unknown): unknown[] {
  if (Array.isArray(data)) return data;
  if (data && typeof data === "object") {
    const value = data as Record<string, unknown>;
    if (Array.isArray(value.data)) return value.data;
    if (Array.isArray(value.items)) return value.items;
  }
  return [];
}

function nonEmptyString(value: unknown): string | undefined {
  return typeof value === "string" && value ? value : undefined;
}
