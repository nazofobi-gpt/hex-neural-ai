import type { DeveloperTransport, DeveloperTransportRequest } from "./developerClient.js";

/** DEV-006: offline, read-only fixture. Never executes or deploys. */
export class LocalDeveloperMockHost implements DeveloperTransport {
  readonly projects = [{ id: "mock-project", name: "Local Fixture" }];

  async request(request: DeveloperTransportRequest): Promise<unknown> {
    if (request.operation === "auth.status"
        && request.method === "GET" && request.path === "/v1/auth/session") {
      return { subject: "local-fixture", scopes: ["auth:read", "projects:read"] };
    }
    if (request.operation === "projects.list"
        && request.method === "GET" && request.path === "/v1/projects") {
      return this.projects.map(project => ({ ...project }));
    }
    throw new Error("LOCAL_MOCK_UNSUPPORTED_OPERATION: read-only fixture");
  }
}
