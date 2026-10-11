"""Run one piece of tool code in a throwaway, locked-down container.

The code defines `main(args)`; a small wrapper (the container's command) decodes the source
and the arguments from the environment, calls `main`, and prints the JSON result after a
per-run marker. Everything the container needs is in its spec: no volume, no network by
default, a read-only root, a small non-executable /tmp, no capabilities, an unprivileged
user, and memory, CPU, process and time limits.
"""

from __future__ import annotations

import base64
import json
import secrets
import time
from dataclasses import dataclass
from typing import Any, Literal

from gouvra.sandbox.docker import DockerClient
from gouvra.sandbox.settings import SandboxSettings

LABEL = "gouvra.sandbox"
NOBODY = "65534:65534"
MAX_SOURCE_CHARS = 50_000
MAX_ARGUMENTS_BYTES = 64 * 1024
MAX_LOG_CHARS = 8_000
GRACE_S = 60  # beyond its timeout, a container left behind by a crash is reaped

PYTHON_WRAPPER = r"""
import asyncio, base64, json, os, sys, traceback
marker = os.environ.pop("GOUVRA_MARKER")
source = base64.b64decode(os.environ.pop("GOUVRA_SOURCE")).decode()
arguments = json.loads(base64.b64decode(os.environ.pop("GOUVRA_ARGS")))
def finish(payload):
    sys.stdout.flush()
    sys.stdout.write("\n" + marker + json.dumps(payload, default=str) + "\n")
    sys.stdout.flush()
try:
    namespace = {"__name__": "tool"}
    exec(compile(source, "tool.py", "exec"), namespace)
    main = namespace.get("main")
    if not callable(main):
        raise NameError("Define a function main(args) that returns the result.")
    result = main(arguments)
    if asyncio.iscoroutine(result):
        result = asyncio.run(result)
    finish({"ok": True, "result": result})
except BaseException as exc:
    frames = [f for f in traceback.extract_tb(exc.__traceback__) if f.filename == "tool.py"]
    where = f" (line {frames[-1].lineno})" if frames else ""
    message = "".join(traceback.format_exception_only(type(exc), exc)).strip()
    finish({"ok": False, "error": (message + where)[-4000:]})
"""

NODE_WRAPPER = r"""
const marker = process.env.GOUVRA_MARKER;
const source = Buffer.from(process.env.GOUVRA_SOURCE, "base64").toString("utf8");
const args = JSON.parse(Buffer.from(process.env.GOUVRA_ARGS, "base64").toString("utf8"));
for (const key of ["GOUVRA_MARKER", "GOUVRA_SOURCE", "GOUVRA_ARGS"]) delete process.env[key];
const finish = (payload) => process.stdout.write("\n" + marker + JSON.stringify(payload) + "\n");
(async () => {
  try {
    const main = new Function(
      "args", "require", source + "\n;return typeof main === 'function' ? main : undefined;"
    )(args, require);
    if (typeof main !== "function") {
      throw new Error("Define a function main(args) that returns the result.");
    }
    const result = await main(args);
    finish({ ok: true, result: result === undefined ? null : result });
  } catch (error) {
    const text = error && error.message ? `${error.name}: ${error.message}` : String(error);
    finish({ ok: false, error: text.slice(0, 4000) });
  }
})();
"""

Language = Literal["python", "javascript"]


@dataclass
class RunRequest:
    language: Language
    source: str
    arguments: dict[str, Any]
    timeout_ms: int
    network: bool = False
    memory_mb: int = 256


@dataclass
class RunResult:
    status: Literal["ok", "error"]
    result: Any = None
    error: str | None = None
    error_code: str | None = None
    logs: str = ""
    duration_ms: int = 0
    exit_code: int | None = None

    def as_dict(self) -> dict[str, Any]:
        return {
            "status": self.status,
            "result": self.result,
            "error": self.error,
            "error_code": self.error_code,
            "logs": self.logs,
            "duration_ms": self.duration_ms,
            "exit_code": self.exit_code,
        }


def _b64(value: str) -> str:
    return base64.b64encode(value.encode()).decode()


def image_for(settings: SandboxSettings, language: Language) -> str:
    return settings.python_image if language == "python" else settings.node_image


def command_for(language: Language) -> list[str]:
    if language == "python":
        return ["python", "-I", "-B", "-c", PYTHON_WRAPPER]
    return ["node", "-e", NODE_WRAPPER]


def container_spec(settings: SandboxSettings, request: RunRequest, marker: str) -> dict[str, Any]:
    memory = request.memory_mb * 1024 * 1024
    timeout_s = request.timeout_ms / 1000
    host: dict[str, Any] = {
        "NetworkMode": "bridge" if request.network else "none",
        "ReadonlyRootfs": True,
        "Tmpfs": {"/tmp": f"rw,noexec,nosuid,nodev,size={settings.tmp_size_mb}m"},  # noqa: S108
        "CapDrop": ["ALL"],
        "SecurityOpt": ["no-new-privileges"],
        "Privileged": False,
        "Memory": memory,
        "MemorySwap": memory,  # no swap: the limit is the limit
        "NanoCpus": int(settings.cpus * 1_000_000_000),
        "PidsLimit": settings.pids_limit,
        "Ulimits": [{"Name": "nofile", "Soft": 256, "Hard": 256}],
        "IpcMode": "private",
        "Init": True,
        "LogConfig": {"Type": "json-file", "Config": {"max-size": "2m"}},
    }
    if settings.runtime:
        host["Runtime"] = settings.runtime
    return {
        "Image": image_for(settings, request.language),
        "Cmd": command_for(request.language),
        "Env": [
            f"GOUVRA_MARKER={marker}",
            f"GOUVRA_SOURCE={_b64(request.source)}",
            f"GOUVRA_ARGS={_b64(json.dumps(request.arguments))}",
            "HOME=/tmp",
            "PYTHONDONTWRITEBYTECODE=1",
        ],
        "User": NOBODY,
        "WorkingDir": "/tmp",  # noqa: S108
        "NetworkDisabled": not request.network,
        "AttachStdout": False,
        "AttachStderr": False,
        "Labels": {LABEL: "1", f"{LABEL}.expires": str(int(time.time() + timeout_s + GRACE_S))},
        "StopTimeout": 1,
        "HostConfig": host,
    }


def parse_output(stdout: bytes, stderr: bytes, marker: str) -> tuple[dict[str, Any] | None, str]:
    """The wrapper's verdict (after the last marker) and what the code printed."""
    text = stdout.decode("utf-8", errors="replace")
    verdict: dict[str, Any] | None = None
    position = text.rfind(marker)
    if position >= 0:
        line = text[position + len(marker) :].split("\n", 1)[0]
        try:
            parsed = json.loads(line)
            verdict = parsed if isinstance(parsed, dict) else None
        except ValueError:
            verdict = None
        text = text[:position]
    printed = text.strip("\n")
    errors = stderr.decode("utf-8", errors="replace").strip("\n")
    logs = "\n".join(part for part in (printed, errors) if part)
    if len(logs) > MAX_LOG_CHARS:
        logs = "… " + logs[-MAX_LOG_CHARS:]
    return verdict, logs


async def run(docker: DockerClient, settings: SandboxSettings, request: RunRequest) -> RunResult:
    marker = f"__GOUVRA_RESULT_{secrets.token_hex(12)}__"
    started = time.perf_counter()
    container_id = await docker.create(container_spec(settings, request, marker))
    timed_out = False
    try:
        await docker.start(container_id)
        try:
            exit_code: int | None = await docker.wait(container_id, request.timeout_ms / 1000)
        except TimeoutError:
            timed_out, exit_code = True, None
            await docker.kill(container_id)
        stdout, stderr = await docker.logs(container_id)
        state = (await docker.inspect(container_id)).get("State", {})
    finally:
        await docker.remove(container_id)
    duration_ms = int((time.perf_counter() - started) * 1000)
    verdict, logs = parse_output(stdout, stderr, marker)
    error, code = _failure(
        request, timed_out=timed_out, state=state, verdict=verdict, exit_code=exit_code
    )
    if code is not None or verdict is None:
        return RunResult(
            "error",
            error=error,
            error_code=code or "no_result",
            logs=logs,
            duration_ms=duration_ms,
            exit_code=exit_code,
        )
    return RunResult(
        "ok", result=verdict.get("result"), logs=logs, duration_ms=duration_ms, exit_code=exit_code
    )


SIGKILL_EXIT = 128 + 9


def _failure(
    request: RunRequest,
    *,
    timed_out: bool,
    state: dict[str, Any],
    verdict: dict[str, Any] | None,
    exit_code: int | None,
) -> tuple[str | None, str | None]:
    """Why a run failed, in words the tool's author can act on — or (None, None)."""
    if timed_out:
        return f"The code ran longer than {request.timeout_ms} ms and was stopped.", "timeout"
    # Docker does not always flag an out-of-memory kill (cgroup v2): a SIGKILL (exit 137) that
    # did not come from the timeout above can only come from the kernel's OOM killer.
    if state.get("OOMKilled") or exit_code == SIGKILL_EXIT:
        return (
            f"The code used more than {request.memory_mb} MB of memory and was stopped.",
            "memory",
        )
    if verdict is None:
        suffix = f" (exit code {exit_code})." if exit_code else "."
        return "The code stopped without returning a result" + suffix, "no_result"
    if not verdict.get("ok"):
        return str(verdict.get("error") or "The code failed."), "code_error"
    return None, None


async def reap(docker: DockerClient) -> int:
    """Remove containers a crashed run left behind (only ours, only once they expired)."""
    removed = 0
    now = time.time()
    for container in await docker.containers(f"{LABEL}=1"):
        expires = container.get("Labels", {}).get(f"{LABEL}.expires", "0")
        if float(expires or 0) < now:
            await docker.remove(container["Id"])
            removed += 1
    return removed
