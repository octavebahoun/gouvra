"""Code sandbox: container hardening, the authenticated service, and real runs under Docker.

Tests marked `docker` need a reachable Docker daemon and are skipped otherwise.
"""

from __future__ import annotations

import asyncio
import contextlib
import json
import socket
import struct
from collections.abc import AsyncIterator
from typing import Any

import httpx
import pytest
import uvicorn
from pydantic import SecretStr

from gouvra.core.config import get_settings
from gouvra.sandbox import runner
from gouvra.sandbox.app import create_sandbox_app
from gouvra.sandbox.docker import DockerClient, DockerError, demultiplex
from gouvra.sandbox.settings import SandboxSettings
from tests.helpers import Account, Outbox, create_workspace, signup

TOKEN = "t" * 40


def settings(**extra: Any) -> SandboxSettings:
    return SandboxSettings(token=SecretStr(TOKEN), **extra)


def request(**extra: Any) -> runner.RunRequest:
    values: dict[str, Any] = {
        "language": "python",
        "source": "def main(args):\n    return args",
        "arguments": {"x": 1},
        "timeout_ms": 5_000,
    }
    return runner.RunRequest(**{**values, **extra})


# ---------------------------------------------------------------- container spec (pure)


def test_container_spec_is_locked_down() -> None:
    spec = runner.container_spec(settings(), request(memory_mb=128), "M")
    host = spec["HostConfig"]
    assert spec["User"] == "65534:65534"
    assert spec["NetworkDisabled"] is True
    assert host["NetworkMode"] == "none"
    assert host["ReadonlyRootfs"] is True
    assert host["CapDrop"] == ["ALL"]
    assert host["SecurityOpt"] == ["no-new-privileges"]
    assert host["Privileged"] is False
    assert host["Memory"] == host["MemorySwap"] == 128 * 1024 * 1024
    assert host["PidsLimit"] == 64
    assert host["NanoCpus"] == 1_000_000_000
    assert "noexec" in host["Tmpfs"]["/tmp"]  # noqa: S108 - the container's tmpfs
    assert "Binds" not in host
    assert "Mounts" not in host
    assert "Runtime" not in host
    assert spec["Labels"]["gouvra.sandbox"] == "1"
    assert int(spec["Labels"]["gouvra.sandbox.expires"]) > 0
    env = dict(item.split("=", 1) for item in spec["Env"])
    assert env["GOUVRA_MARKER"] == "M"
    assert json.loads(__import__("base64").b64decode(env["GOUVRA_ARGS"])) == {"x": 1}
    assert spec["Cmd"][:3] == ["python", "-I", "-B"]


def test_container_spec_options() -> None:
    gvisor = runner.container_spec(settings(runtime="runsc"), request(network=True), "M")
    assert gvisor["HostConfig"]["Runtime"] == "runsc"
    assert gvisor["HostConfig"]["NetworkMode"] == "bridge"
    node = runner.container_spec(settings(), request(language="javascript"), "M")
    assert node["Image"].startswith("node:")
    assert node["Cmd"][:2] == ["node", "-e"]


def test_log_stream_demultiplexing_and_result_parsing() -> None:
    def frame(kind: int, data: bytes) -> bytes:
        return bytes([kind, 0, 0, 0]) + struct.pack(">I", len(data)) + data

    stdout, stderr = demultiplex(frame(1, b"hello\n") + frame(2, b"oops\n") + frame(1, b"MARK"))
    assert (stdout, stderr) == (b"hello\nMARK", b"oops\n")
    verdict, logs = runner.parse_output(
        b'printed\nMARK{"ok": false}\nMARK{"ok": true, "result": 3}\n', b"warning\n", "MARK"
    )
    assert verdict == {"ok": True, "result": 3}
    assert logs == 'printed\nMARK{"ok": false}\nwarning'
    assert runner.parse_output(b"no marker", b"", "MARK") == (None, "no marker")
    assert runner.parse_output(b"MARK{broken", b"", "MARK")[0] is None
    long_verdict, long_logs = runner.parse_output(b"x" * 20_000, b"", "MARK")
    assert long_verdict is None
    assert long_logs.startswith("… ")
    assert len(long_logs) == runner.MAX_LOG_CHARS + 2


# ---------------------------------------------------------------- the service (fake Docker)


class FakeDocker:
    def __init__(self, *, images: bool = True, exit_code: int = 0) -> None:
        self.images = images
        self.exit_code = exit_code
        self.created: list[dict[str, Any]] = []
        self.removed: list[str] = []
        self.pulled: list[str] = []
        self.fail_create = False
        self.block: asyncio.Event | None = None

    async def ping(self) -> bool:
        return True

    async def has_image(self, image: str) -> bool:
        return self.images

    async def pull(self, image: str, **_: Any) -> None:
        self.pulled.append(image)

    async def create(self, spec: dict[str, Any]) -> str:
        if self.fail_create:
            raise DockerError(500, "no space left on device")
        self.created.append(spec)
        return f"c{len(self.created)}"

    async def start(self, container_id: str) -> None:
        if self.block is not None:
            await self.block.wait()

    async def wait(self, container_id: str, limit_s: float) -> int:
        return self.exit_code

    async def kill(self, container_id: str) -> None:
        pass

    async def logs(self, container_id: str) -> tuple[bytes, bytes]:
        marker = dict(i.split("=", 1) for i in self.created[-1]["Env"])["GOUVRA_MARKER"]
        return f'hi\n{marker}{{"ok": true, "result": 42}}\n'.encode(), b""

    async def inspect(self, container_id: str) -> dict[str, Any]:
        return {"State": {"OOMKilled": False}}

    async def remove(self, container_id: str) -> None:
        self.removed.append(container_id)

    async def containers(self, label: str) -> list[dict[str, Any]]:
        return [
            {"Id": "old", "Labels": {"gouvra.sandbox.expires": "1"}},
            {"Id": "live", "Labels": {"gouvra.sandbox.expires": "99999999999"}},
        ]


@contextlib.asynccontextmanager
async def service(docker: Any, **extra: Any) -> AsyncIterator[httpx.AsyncClient]:
    app = create_sandbox_app(settings(**extra), docker)
    async with app.router.lifespan_context(app):
        transport = httpx.ASGITransport(app=app)
        async with httpx.AsyncClient(transport=transport, base_url="http://sandbox") as client:
            client.headers["Authorization"] = f"Bearer {TOKEN}"
            yield client


def test_failure_explanations() -> None:
    req = request(memory_mb=64)
    fail = runner._failure  # the wording users read is part of the contract
    assert fail(req, timed_out=True, state={}, verdict=None, exit_code=None)[1] == "timeout"
    assert fail(req, timed_out=False, state={"OOMKilled": True}, verdict=None, exit_code=137) == (
        "The code used more than 64 MB of memory and was stopped.",
        "memory",
    )
    # cgroup v2: Docker may not flag the OOM kill, but the kernel's SIGKILL still shows.
    assert fail(req, timed_out=False, state={}, verdict=None, exit_code=137)[1] == "memory"
    assert fail(req, timed_out=False, state={}, verdict=None, exit_code=1) == (
        "The code stopped without returning a result (exit code 1).",
        "no_result",
    )
    assert fail(
        req, timed_out=False, state={}, verdict={"ok": False, "error": "Boom"}, exit_code=1
    ) == (
        "Boom",
        "code_error",
    )
    assert fail(req, timed_out=False, state={}, verdict={"ok": True}, exit_code=0) == (None, None)


def test_service_refuses_to_start_without_a_strong_token() -> None:
    with pytest.raises(RuntimeError, match="SANDBOX_TOKEN"):
        create_sandbox_app(SandboxSettings(token=SecretStr("short")), FakeDocker())  # type: ignore[arg-type]


async def test_service_runs_code_and_cleans_up() -> None:
    docker = FakeDocker()
    async with service(docker) as client:
        body = {"source": "def main(a):\n    return 42", "arguments": {"n": 1}}
        response = await client.post("/v1/run", json=body)
        assert response.status_code == 200, response.text
        result = response.json()
        assert (result["status"], result["result"], result["logs"]) == ("ok", 42, "hi")
        assert docker.removed == ["c1"]
        assert (await client.get("/healthz")).json() == {"status": "ok"}
        ready = await client.get("/readyz")
        assert (ready.status_code, ready.json()["status"]) == (200, "ready")


async def test_service_guards() -> None:
    docker = FakeDocker()
    async with service(docker) as client:
        body = {"source": "def main(a):\n    return 1"}
        for headers in ({"Authorization": ""}, {"Authorization": "Bearer wrong"}):
            refused = await client.post("/v1/run", json=body, headers=headers)
            assert refused.status_code == 401
        too_big = await client.post("/v1/run", json={**body, "arguments": {"x": "y" * 70_000}})
        assert too_big.status_code == 422
        too_long = await client.post("/v1/run", json={**body, "timeout_ms": 600_000})
        assert too_long.status_code == 422
        offline = (await client.post("/v1/run", json={**body, "network": True})).json()
        assert offline["error_code"] == "network_disabled"
        docker.fail_create = True
        broken = (await client.post("/v1/run", json=body)).json()
        assert broken["error_code"] == "sandbox_error"
        assert docker.created == []  # nothing ran


async def test_service_prepares_missing_images_and_limits_concurrency(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    missing = FakeDocker(images=False)
    async with service(missing) as client:
        body = {"source": "def main(a):\n    return 1"}
        preparing = (await client.post("/v1/run", json=body)).json()
        assert preparing["error_code"] == "preparing"
        await asyncio.sleep(0)
        assert settings().python_image in missing.pulled
        assert (await client.get("/readyz")).status_code == 503

    monkeypatch.setattr("gouvra.sandbox.app.SLOT_WAIT_S", 0.2)
    slow = FakeDocker()
    slow.block = asyncio.Event()
    async with service(slow, max_concurrency=1) as client:
        first = asyncio.create_task(client.post("/v1/run", json=body))
        await asyncio.sleep(0.05)
        busy = (await client.post("/v1/run", json=body)).json()
        assert busy["error_code"] == "busy"
        slow.block.set()
        assert (await first).json()["status"] == "ok"


async def test_reaper_removes_only_expired_containers() -> None:
    docker = FakeDocker()
    assert await runner.reap(docker) == 1  # type: ignore[arg-type]
    assert docker.removed == ["old"]


# ---------------------------------------------------------------- real runs (Docker)


@pytest.fixture
async def docker() -> AsyncIterator[DockerClient]:
    client = DockerClient("unix:///var/run/docker.sock")
    if not await client.ping():
        await client.aclose()
        pytest.skip("Docker is not reachable")
    for image in (settings().python_image, settings().node_image):
        if not await client.has_image(image):
            await client.pull(image)
    try:
        yield client
    finally:
        leftovers = await client.containers("gouvra.sandbox=1")
        await client.aclose()
        assert leftovers == [], "a sandbox container was left behind"


async def _run(docker: DockerClient, source: str, **extra: Any) -> runner.RunResult:
    return await runner.run(docker, settings(), request(source=source, **extra))


@pytest.mark.docker
async def test_python_and_javascript_tools_run(docker: DockerClient) -> None:
    python = await _run(
        docker,
        "import math\n"
        "def main(args):\n"
        "    print('computing')\n"
        "    return {'root': math.sqrt(args['x'])}",
        arguments={"x": 16},
    )
    assert (python.status, python.result, python.logs) == ("ok", {"root": 4.0}, "computing")
    javascript = await _run(
        docker,
        "async function main(args) {\n  console.log('hi');\n  return args.items.length;\n}",
        language="javascript",
        arguments={"items": [1, 2, 3]},
    )
    assert (javascript.status, javascript.result, javascript.logs) == ("ok", 3, "hi")


@pytest.mark.docker
async def test_code_errors_are_explained(docker: DockerClient) -> None:
    raised = await _run(docker, "def main(args):\n    x = 1\n    return args['missing']")
    assert (raised.status, raised.error_code) == ("error", "code_error")
    assert raised.error == "KeyError: 'missing' (line 3)"
    syntax = await _run(docker, "def main(args) return 1")
    assert syntax.error_code == "code_error"
    assert "SyntaxError" in (syntax.error or "")
    no_main = await _run(docker, "x = 1")
    assert "Define a function main(args)" in (no_main.error or "")
    exited = await _run(docker, "import os\ndef main(args):\n    os._exit(3)")
    assert (exited.error_code, exited.exit_code) == ("no_result", 3)
    js = await _run(docker, "function main() { throw new TypeError('bad') }", language="javascript")
    assert js.error == "TypeError: bad"


@pytest.mark.docker
async def test_the_container_is_isolated(docker: DockerClient) -> None:
    probe = """
import os, socket
def main(args):
    found = {"uid": os.getuid(), "env": sorted(k for k in os.environ if k.startswith("GOUVRA"))}
    try:
        socket.create_connection(("1.1.1.1", 53), timeout=2)
        found["network"] = "open"
    except OSError as exc:
        found["network"] = type(exc).__name__
    for path in ("/etc/pwned", "/tmp/scratch"):
        try:
            with open(path, "w") as handle:
                handle.write("x")
            found[path] = "writable"
        except OSError:
            found[path] = "read-only"
    found["exec_tmp"] = os.access("/tmp/scratch", os.X_OK)
    return found
"""
    result = await _run(docker, probe)
    assert result.status == "ok", result.error
    assert result.result["uid"] == 65534
    assert result.result["env"] == []  # the wrapper removed its inputs
    assert result.result["network"] != "open"
    assert result.result["/etc/pwned"] == "read-only"
    assert result.result["/tmp/scratch"] == "writable"  # noqa: S108 - inside the container
    assert result.result["exec_tmp"] is False


@pytest.mark.docker
async def test_time_and_memory_limits(docker: DockerClient) -> None:
    spin = await _run(docker, "def main(args):\n    while True:\n        pass", timeout_ms=1_500)
    assert (spin.status, spin.error_code) == ("error", "timeout")
    assert spin.duration_ms < 10_000
    greedy = await _run(
        docker,
        "def main(args):\n"
        "    blocks = []\n"
        "    while True:\n"
        "        blocks.append(bytearray(8 * 1024 * 1024))",
        memory_mb=64,
    )
    assert greedy.error_code in {"memory", "code_error"}  # killed, or MemoryError raised first
    if greedy.error_code == "code_error":
        assert "MemoryError" in (greedy.error or "")


# ---------------------------------------------------------------- API → sandbox → Docker


def _free_port() -> int:
    with socket.socket() as probe:
        probe.bind(("127.0.0.1", 0))
        port: int = probe.getsockname()[1]
        return port


@pytest.mark.docker
async def test_code_tool_runs_through_the_sandbox(
    docker: DockerClient,
    make_client: Any,
    outbox: Outbox,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    port = _free_port()
    server = uvicorn.Server(
        uvicorn.Config(create_sandbox_app(settings()), host="127.0.0.1", port=port, log_config=None)
    )
    serving = asyncio.create_task(server.serve())
    try:
        for _ in range(100):
            if server.started:
                break
            await asyncio.sleep(0.05)
        monkeypatch.setattr(get_settings(), "sandbox_url", f"http://127.0.0.1:{port}")
        monkeypatch.setattr(get_settings(), "sandbox_token", SecretStr(TOKEN))
        owner: Account = await signup(make_client(), outbox, "coder@example.com")
        ws = await create_workspace(owner, "Code")
        created = await owner.client.post(
            f"/api/v1/workspaces/{ws['id']}/tools",
            json={
                "kind": "code",
                "name": "word_count",
                "display_name": "Word count",
                "description": "Counts the words of a text.",
                "input_schema": {
                    "type": "object",
                    "required": ["text"],
                    "properties": {"text": {"type": "string"}},
                    "additionalProperties": False,
                },
                "config": {
                    "language": "python",
                    "source": "def main(args):\n    return {'words': len(args['text'].split())}",
                },
            },
        )
        assert created.status_code == 201, created.text
        tool_id = created.json()["id"]
        tested = await owner.client.post(
            f"/api/v1/tools/{tool_id}/test", json={"arguments": {"text": "one two three"}}
        )
        assert tested.status_code == 200, tested.text
        assert tested.json()["ok"] is True
        assert tested.json()["output"] == {"words": 3}
        failing = await owner.client.patch(
            f"/api/v1/tools/{tool_id}",
            json={"config": {"language": "python", "source": "def main(args):\n    return 1 / 0"}},
        )
        assert failing.status_code == 200, failing.text
        broken = await owner.client.post(
            f"/api/v1/tools/{tool_id}/test", json={"arguments": {"text": "x"}}
        )
        assert broken.json()["ok"] is False
        assert "ZeroDivisionError" in broken.json()["error_message"]
    finally:
        server.should_exit = True
        await asyncio.wait_for(serving, timeout=15)
