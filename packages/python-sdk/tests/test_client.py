import unittest

from hex_neural_sdk import AuthContext, DeveloperClient, DeveloperClientError


class RecordingTransport:
    def __init__(self, response):
        self.response = response
        self.calls = []

    def request(self, request):
        self.calls.append(request)
        return self.response(request) if callable(self.response) else self.response


class DeveloperClientTests(unittest.TestCase):
    def test_inline_secret_rejected_before_transport(self):
        transport = RecordingTransport({"subject": "u", "scopes": ["auth:read"]})
        client = DeveloperClient(transport, AuthContext("sk-proj-secret", ("auth:read",)))
        with self.assertRaises(DeveloperClientError) as raised:
            client.auth_status()
        self.assertEqual(raised.exception.code, "INVALID_CREDENTIAL_REFERENCE")
        self.assertEqual(transport.calls, [])

    def test_missing_scope_fails_closed(self):
        transport = RecordingTransport([])
        client = DeveloperClient(transport, AuthContext("vault://workspace/dev", ("auth:read",)))
        with self.assertRaises(DeveloperClientError) as raised:
            client.list_projects()
        self.assertEqual(raised.exception.code, "MISSING_SCOPE")
        self.assertEqual(transport.calls, [])

    def test_project_route_is_fixed_and_typed(self):
        transport = RecordingTransport([{"id": "project-a", "name": "Project A"}])
        client = DeveloperClient(transport, AuthContext("vault://workspace/dev", ("projects:read",)))
        self.assertEqual(client.list_projects()[0].id, "project-a")
        self.assertEqual(
            transport.calls[0],
            {
                "operation": "projects.list",
                "method": "GET",
                "path": "/v1/projects",
                "credentialRef": "vault://workspace/dev",
            },
        )

    def test_path_traversal_rejected_before_transport(self):
        transport = RecordingTransport({"runId": "run-1", "state": "QUEUED"})
        client = DeveloperClient(
            transport,
            AuthContext("vault://workspace/dev", ("runs:execute", "logs:read")),
        )
        with self.assertRaises(DeveloperClientError) as raised:
            client.start_run("../escape", "graph-a", "v1")
        self.assertEqual(raised.exception.code, "INVALID_IDENTIFIER")
        with self.assertRaises(DeveloperClientError) as raised:
            client.read_logs("run/../../secret")
        self.assertEqual(raised.exception.code, "INVALID_IDENTIFIER")
        self.assertEqual(transport.calls, [])

    def test_deploy_requires_explicit_confirmation(self):
        transport = RecordingTransport({"deploymentId": "dep-1", "state": "STAGED"})
        client = DeveloperClient(
            transport,
            AuthContext("vault://workspace/dev", ("deployments:write",)),
        )
        with self.assertRaises(DeveloperClientError) as raised:
            client.deploy("project-a", "graph-a", "v1", "staging", confirm=False)
        self.assertEqual(raised.exception.code, "EXPLICIT_CONFIRMATION_REQUIRED")
        self.assertEqual(transport.calls, [])

    def test_scoped_run_and_bounded_logs(self):
        def response(request):
            if request["operation"] == "runs.start":
                return {"runId": "run-1", "state": "QUEUED"}
            return {
                "runId": "run-1",
                "events": [{"at": "2026-10-07T12:00:00Z", "level": "INFO", "message": "queued"}],
            }

        transport = RecordingTransport(response)
        client = DeveloperClient(
            transport,
            AuthContext("vault://workspace/dev", ("runs:execute", "logs:read")),
        )
        self.assertEqual(client.start_run("project-a", "graph-a", "v1").run_id, "run-1")
        self.assertEqual(client.read_logs("run-1").events[0].message, "queued")

    def test_unbounded_logs_fail_closed(self):
        transport = RecordingTransport(
            {
                "runId": "run-1",
                "events": [
                    {"at": "2026-10-07T12:00:00Z", "level": "INFO", "message": "x"}
                    for _ in range(1001)
                ],
            }
        )
        client = DeveloperClient(transport, AuthContext("vault://workspace/dev", ("logs:read",)))
        with self.assertRaises(DeveloperClientError) as raised:
            client.read_logs("run-1")
        self.assertEqual(raised.exception.code, "INVALID_TRANSPORT_RESPONSE")


if __name__ == "__main__":
    unittest.main()
