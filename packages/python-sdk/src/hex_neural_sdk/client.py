from __future__ import annotations

from dataclasses import dataclass
from typing import Any, Callable, Mapping, Protocol, Sequence
import re

Scope = str
_ALLOWED_SCOPES = {
    "auth:read",
    "projects:read",
    "runs:execute",
    "deployments:write",
    "logs:read",
}
_ID_PATTERN = re.compile(r"^[A-Za-z0-9._-]{1,128}$")
_VAULT_PATTERN = re.compile(r"^vault://[A-Za-z0-9][A-Za-z0-9._/-]{0,255}$")
_MAX_LOG_EVENTS = 1000


class DeveloperClientError(Exception):
    def __init__(self, code: str, message: str) -> None:
        super().__init__(message)
        self.code = code


@dataclass(frozen=True)
class AuthContext:
    credential_ref: str
    scopes: tuple[Scope, ...]


@dataclass(frozen=True)
class ProjectSummary:
    id: str
    name: str


@dataclass(frozen=True)
class RunReceipt:
    run_id: str
    state: str


@dataclass(frozen=True)
class DeploymentReceipt:
    deployment_id: str
    state: str


@dataclass(frozen=True)
class LogEvent:
    at: str
    level: str
    message: str


@dataclass(frozen=True)
class RunLogs:
    run_id: str
    events: tuple[LogEvent, ...]


class Transport(Protocol):
    def request(self, request: Mapping[str, Any]) -> Any: ...


def _identifier(name: str, value: str) -> str:
    if not isinstance(value, str) or _ID_PATTERN.fullmatch(value) is None:
        raise DeveloperClientError("INVALID_IDENTIFIER", f"{name} is not a safe identifier.")
    return value


def _authorize(context: AuthContext, required: Scope) -> str:
    if _VAULT_PATTERN.fullmatch(context.credential_ref) is None:
        raise DeveloperClientError(
            "INVALID_CREDENTIAL_REFERENCE",
            "Credentials must be supplied as a vault:// reference; inline secrets are rejected.",
        )
    if required not in _ALLOWED_SCOPES or required not in context.scopes:
        raise DeveloperClientError("MISSING_SCOPE", f"Operation requires explicit {required} scope.")
    return context.credential_ref


def _record(value: Any, message: str) -> Mapping[str, Any]:
    if not isinstance(value, Mapping):
        raise DeveloperClientError("INVALID_TRANSPORT_RESPONSE", message)
    return value


def _parse_scopes(value: Any) -> tuple[str, ...]:
    if not isinstance(value, Sequence) or isinstance(value, (str, bytes)):
        raise DeveloperClientError("INVALID_TRANSPORT_RESPONSE", "Auth scopes are malformed.")
    result = tuple(value)
    if any(not isinstance(scope, str) or scope not in _ALLOWED_SCOPES for scope in result):
        raise DeveloperClientError("INVALID_TRANSPORT_RESPONSE", "Auth scopes are malformed.")
    return result


class DeveloperClient:
    """Policy-bound Python developer client.

    This client passes only opaque vault references to a transport. It never accepts
    bearer/API secrets, exposes no generic request escape hatch, and treats each
    typed method as requiring an explicit scope. A client method is not an
    authorization decision by itself; the remote/runtime policy remains authoritative.
    """

    def __init__(self, transport: Transport, context: AuthContext) -> None:
        self._transport = transport
        self._context = context

    def auth_status(self) -> Mapping[str, Any]:
        credential_ref = _authorize(self._context, "auth:read")
        response = _record(
            self._transport.request(
                {
                    "operation": "auth.status",
                    "method": "GET",
                    "path": "/v1/auth/session",
                    "credentialRef": credential_ref,
                }
            ),
            "Auth status response is malformed.",
        )
        subject = response.get("subject")
        scopes = _parse_scopes(response.get("scopes"))
        if not isinstance(subject, str) or not subject.strip():
            raise DeveloperClientError("INVALID_TRANSPORT_RESPONSE", "Auth status response is malformed.")
        return {"subject": subject, "scopes": scopes}

    def list_projects(self) -> tuple[ProjectSummary, ...]:
        credential_ref = _authorize(self._context, "projects:read")
        response = self._transport.request(
            {
                "operation": "projects.list",
                "method": "GET",
                "path": "/v1/projects",
                "credentialRef": credential_ref,
            }
        )
        if not isinstance(response, Sequence) or isinstance(response, (str, bytes)):
            raise DeveloperClientError("INVALID_TRANSPORT_RESPONSE", "Project list response is malformed.")
        projects: list[ProjectSummary] = []
        for raw in response:
            item = _record(raw, "Project list contains a malformed project.")
            project_id = item.get("id")
            name = item.get("name")
            if (
                not isinstance(project_id, str)
                or _ID_PATTERN.fullmatch(project_id) is None
                or not isinstance(name, str)
                or not name.strip()
            ):
                raise DeveloperClientError(
                    "INVALID_TRANSPORT_RESPONSE",
                    "Project list contains a malformed project.",
                )
            projects.append(ProjectSummary(project_id, name))
        return tuple(projects)

    def start_run(self, project_id: str, graph_id: str, graph_version: str) -> RunReceipt:
        credential_ref = _authorize(self._context, "runs:execute")
        project = _identifier("projectId", project_id)
        graph = _identifier("graphId", graph_id)
        version = _identifier("graphVersion", graph_version)
        response = _record(
            self._transport.request(
                {
                    "operation": "runs.start",
                    "method": "POST",
                    "path": f"/v1/projects/{project}/runs",
                    "credentialRef": credential_ref,
                    "body": {"graphId": graph, "graphVersion": version},
                }
            ),
            "Run response is malformed.",
        )
        run_id = response.get("runId")
        state = response.get("state")
        if (
            not isinstance(run_id, str)
            or _ID_PATTERN.fullmatch(run_id) is None
            or state not in {"QUEUED", "RUNNING"}
        ):
            raise DeveloperClientError("INVALID_TRANSPORT_RESPONSE", "Run response is malformed.")
        return RunReceipt(run_id, state)

    def deploy(
        self,
        project_id: str,
        graph_id: str,
        graph_version: str,
        environment: str,
        *,
        confirm: bool,
    ) -> DeploymentReceipt:
        credential_ref = _authorize(self._context, "deployments:write")
        if confirm is not True:
            raise DeveloperClientError(
                "EXPLICIT_CONFIRMATION_REQUIRED",
                "Deployment requires explicit confirmation.",
            )
        project = _identifier("projectId", project_id)
        graph = _identifier("graphId", graph_id)
        version = _identifier("graphVersion", graph_version)
        env = _identifier("environment", environment)
        response = _record(
            self._transport.request(
                {
                    "operation": "deployments.create",
                    "method": "POST",
                    "path": f"/v1/projects/{project}/deployments",
                    "credentialRef": credential_ref,
                    "body": {
                        "graphId": graph,
                        "graphVersion": version,
                        "environment": env,
                        "confirm": True,
                    },
                }
            ),
            "Deployment response is malformed.",
        )
        deployment_id = response.get("deploymentId")
        state = response.get("state")
        if (
            not isinstance(deployment_id, str)
            or _ID_PATTERN.fullmatch(deployment_id) is None
            or state not in {"STAGED", "ACTIVE"}
        ):
            raise DeveloperClientError("INVALID_TRANSPORT_RESPONSE", "Deployment response is malformed.")
        return DeploymentReceipt(deployment_id, state)

    def read_logs(self, run_id: str) -> RunLogs:
        credential_ref = _authorize(self._context, "logs:read")
        run = _identifier("runId", run_id)
        response = _record(
            self._transport.request(
                {
                    "operation": "logs.read",
                    "method": "GET",
                    "path": f"/v1/runs/{run}/logs",
                    "credentialRef": credential_ref,
                }
            ),
            "Run log response is malformed.",
        )
        response_run_id = response.get("runId")
        events = response.get("events")
        if (
            not isinstance(response_run_id, str)
            or _ID_PATTERN.fullmatch(response_run_id) is None
            or not isinstance(events, Sequence)
            or isinstance(events, (str, bytes))
            or len(events) > _MAX_LOG_EVENTS
        ):
            raise DeveloperClientError(
                "INVALID_TRANSPORT_RESPONSE",
                "Run log response is malformed or exceeds the bounded event limit.",
            )
        parsed: list[LogEvent] = []
        for raw in events:
            event = _record(raw, "Run log response contains a malformed event.")
            at = event.get("at")
            level = event.get("level")
            message = event.get("message")
            if (
                not isinstance(at, str)
                or level not in {"DEBUG", "INFO", "WARN", "ERROR"}
                or not isinstance(message, str)
            ):
                raise DeveloperClientError(
                    "INVALID_TRANSPORT_RESPONSE",
                    "Run log response contains a malformed event.",
                )
            parsed.append(LogEvent(at, level, message))
        return RunLogs(response_run_id, tuple(parsed))
