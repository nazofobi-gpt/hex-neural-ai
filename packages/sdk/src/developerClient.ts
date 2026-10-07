export type DeveloperScope =
  | "auth:read"
  | "projects:read"
  | "runs:execute"
  | "deployments:write"
  | "logs:read";

export interface DeveloperAuthContext {
  readonly credentialRef: string;
  readonly scopes: readonly DeveloperScope[];
}

export interface AuthStatus {
  readonly subject: string;
  readonly scopes: readonly DeveloperScope[];
}

export interface ProjectSummary {
  readonly id: string;
  readonly name: string;
}

export interface RunRequest {
  readonly graphId: string;
  readonly graphVersion: string;
}

export interface RunReceipt {
  readonly runId: string;
  readonly state: "QUEUED" | "RUNNING";
}

export interface DeploymentRequest {
  readonly graphId: string;
  readonly graphVersion: string;
  readonly environment: string;
  readonly confirm: true;
}

export interface DeploymentReceipt {
  readonly deploymentId: string;
  readonly state: "STAGED" | "ACTIVE";
}

export interface LogEvent {
  readonly at: string;
  readonly level: "DEBUG" | "INFO" | "WARN" | "ERROR";
  readonly message: string;
}

export interface RunLogs {
  readonly runId: string;
  readonly events: readonly LogEvent[];
}

export type DeveloperTransportRequest =
  | {
      readonly operation: "auth.status";
      readonly method: "GET";
      readonly path: "/v1/auth/session";
      readonly credentialRef: string;
    }
  | {
      readonly operation: "projects.list";
      readonly method: "GET";
      readonly path: "/v1/projects";
      readonly credentialRef: string;
    }
  | {
      readonly operation: "runs.start";
      readonly method: "POST";
      readonly path: `/v1/projects/${string}/runs`;
      readonly credentialRef: string;
      readonly body: RunRequest;
    }
  | {
      readonly operation: "deployments.create";
      readonly method: "POST";
      readonly path: `/v1/projects/${string}/deployments`;
      readonly credentialRef: string;
      readonly body: DeploymentRequest;
    }
  | {
      readonly operation: "logs.read";
      readonly method: "GET";
      readonly path: `/v1/runs/${string}/logs`;
      readonly credentialRef: string;
    };

export interface DeveloperTransport {
  request(request: DeveloperTransportRequest): Promise<unknown>;
}

export type DeveloperClientErrorCode =
  | "INVALID_CREDENTIAL_REFERENCE"
  | "MISSING_SCOPE"
  | "INVALID_IDENTIFIER"
  | "EXPLICIT_CONFIRMATION_REQUIRED"
  | "INVALID_TRANSPORT_RESPONSE";

export class DeveloperClientError extends Error {
  constructor(
    public readonly code: DeveloperClientErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "DeveloperClientError";
  }
}

const MAX_LOG_EVENTS = 1_000;
const ID_PATTERN = /^[A-Za-z0-9._-]{1,128}$/;
const VAULT_REF_PATTERN = /^vault:\/\/[A-Za-z0-9][A-Za-z0-9._/-]{0,255}$/;

function record(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function identifier(name: string, value: string): string {
  if (!ID_PATTERN.test(value)) {
    throw new DeveloperClientError("INVALID_IDENTIFIER", `${name} is not a safe identifier.`);
  }
  return value;
}

function authorize(context: DeveloperAuthContext, required: DeveloperScope): string {
  if (!VAULT_REF_PATTERN.test(context.credentialRef)) {
    throw new DeveloperClientError(
      "INVALID_CREDENTIAL_REFERENCE",
      "Credentials must be supplied as a vault:// reference; inline secrets are rejected.",
    );
  }
  if (!context.scopes.includes(required)) {
    throw new DeveloperClientError(
      "MISSING_SCOPE",
      `Operation requires explicit ${required} scope.`,
    );
  }
  return context.credentialRef;
}

function invalidEnvelope(message: string): never {
  throw new DeveloperClientError("INVALID_TRANSPORT_RESPONSE", message);
}

function scopes(value: unknown): value is DeveloperScope[] {
  return Array.isArray(value)
    && value.every((scope) => [
      "auth:read",
      "projects:read",
      "runs:execute",
      "deployments:write",
      "logs:read",
    ].includes(String(scope)));
}

function parseAuth(value: unknown): AuthStatus {
  const r = record(value);
  if (!r || typeof r.subject !== "string" || !r.subject.trim() || !scopes(r.scopes)) {
    return invalidEnvelope("Auth status response is malformed.");
  }
  return { subject: r.subject, scopes: r.scopes };
}

function parseProjects(value: unknown): ProjectSummary[] {
  if (!Array.isArray(value)) return invalidEnvelope("Project list response is malformed.");
  return value.map((value) => {
    const r = record(value);
    if (!r || typeof r.id !== "string" || typeof r.name !== "string"
      || !ID_PATTERN.test(r.id) || !r.name.trim()) {
      return invalidEnvelope("Project list contains a malformed project.");
    }
    return { id: r.id, name: r.name };
  });
}

function parseRun(value: unknown): RunReceipt {
  const r = record(value);
  if (!r || typeof r.runId !== "string" || !ID_PATTERN.test(r.runId)
    || (r.state !== "QUEUED" && r.state !== "RUNNING")) {
    return invalidEnvelope("Run response is malformed.");
  }
  return { runId: r.runId, state: r.state };
}

function parseDeployment(value: unknown): DeploymentReceipt {
  const r = record(value);
  if (!r || typeof r.deploymentId !== "string" || !ID_PATTERN.test(r.deploymentId)
    || (r.state !== "STAGED" && r.state !== "ACTIVE")) {
    return invalidEnvelope("Deployment response is malformed.");
  }
  return { deploymentId: r.deploymentId, state: r.state };
}

function parseLogs(value: unknown): RunLogs {
  const r = record(value);
  if (!r || typeof r.runId !== "string" || !ID_PATTERN.test(r.runId)
    || !Array.isArray(r.events) || r.events.length > MAX_LOG_EVENTS) {
    return invalidEnvelope("Run log response is malformed or exceeds the bounded event limit.");
  }
  const events = r.events.map((event) => {
    const e = record(event);
    if (!e || typeof e.at !== "string" || typeof e.message !== "string"
      || !["DEBUG", "INFO", "WARN", "ERROR"].includes(String(e.level))) {
      return invalidEnvelope("Run log response contains a malformed event.");
    }
    return {
      at: e.at,
      level: e.level as LogEvent["level"],
      message: e.message,
    };
  });
  return { runId: r.runId, events };
}

/**
 * DEV-003 typed operation surface.
 *
 * This client never accepts raw bearer/API secrets and exposes no generic request
 * escape hatch. Each operation requires a vault reference plus its explicit scope.
 * The transport owns credential materialization; this layer only passes the opaque
 * reference. A typed method is not authorization by itself.
 */
export class HexDeveloperClient {
  constructor(
    private readonly transport: DeveloperTransport,
    private readonly context: DeveloperAuthContext,
  ) {}

  async authStatus(): Promise<AuthStatus> {
    const credentialRef = authorize(this.context, "auth:read");
    return parseAuth(await this.transport.request({
      operation: "auth.status",
      method: "GET",
      path: "/v1/auth/session",
      credentialRef,
    }));
  }

  async listProjects(): Promise<readonly ProjectSummary[]> {
    const credentialRef = authorize(this.context, "projects:read");
    return parseProjects(await this.transport.request({
      operation: "projects.list",
      method: "GET",
      path: "/v1/projects",
      credentialRef,
    }));
  }

  async startRun(projectId: string, request: RunRequest): Promise<RunReceipt> {
    const credentialRef = authorize(this.context, "runs:execute");
    const project = identifier("projectId", projectId);
    identifier("graphId", request.graphId);
    identifier("graphVersion", request.graphVersion);
    return parseRun(await this.transport.request({
      operation: "runs.start",
      method: "POST",
      path: `/v1/projects/${project}/runs`,
      credentialRef,
      body: request,
    }));
  }

  async deploy(
    projectId: string,
    request: Omit<DeploymentRequest, "confirm"> & { readonly confirm: boolean },
  ): Promise<DeploymentReceipt> {
    const credentialRef = authorize(this.context, "deployments:write");
    if (request.confirm !== true) {
      throw new DeveloperClientError(
        "EXPLICIT_CONFIRMATION_REQUIRED",
        "Deployment requires explicit confirmation.",
      );
    }
    const project = identifier("projectId", projectId);
    identifier("graphId", request.graphId);
    identifier("graphVersion", request.graphVersion);
    identifier("environment", request.environment);
    const body: DeploymentRequest = {
      graphId: request.graphId,
      graphVersion: request.graphVersion,
      environment: request.environment,
      confirm: true,
    };
    return parseDeployment(await this.transport.request({
      operation: "deployments.create",
      method: "POST",
      path: `/v1/projects/${project}/deployments`,
      credentialRef,
      body,
    }));
  }

  async readLogs(runId: string): Promise<RunLogs> {
    const credentialRef = authorize(this.context, "logs:read");
    const run = identifier("runId", runId);
    return parseLogs(await this.transport.request({
      operation: "logs.read",
      method: "GET",
      path: `/v1/runs/${run}/logs`,
      credentialRef,
    }));
  }
}
