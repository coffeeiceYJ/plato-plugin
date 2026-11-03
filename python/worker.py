"""One Run per process. stdout is JSONL; the algorithm's diagnostics use stderr."""
import asyncio
import json
import os
import sys
import traceback
from pathlib import Path

PROTOCOL = 1
MAX_LINE = 4 * 1024 * 1024
wire = sys.stdout
run_id = ""
stage = "preparation"


def emit(message_type, **data):
    message = {"protocol": PROTOCOL, "runId": run_id, "type": message_type, **data}
    line = json.dumps(message, ensure_ascii=False)
    if len(line.encode("utf-8")) > MAX_LINE:
        raise RuntimeError("PLATO_PROTOCOL_LIMIT: message exceeds 4 MiB")
    wire.write(line + "\n")
    wire.flush()


def receive():
    line = sys.stdin.buffer.readline(MAX_LINE + 1)
    if not line or len(line) > MAX_LINE or not line.endswith(b"\n"):
        raise RuntimeError("PLATO_PROTOCOL_INVALID: missing or oversized input message")
    value = json.loads(line)
    if not isinstance(value, dict) or value.get("protocol") != PROTOCOL:
        raise RuntimeError("PLATO_PROTOCOL_INVALID: unsupported protocol")
    return value


class ModelBridge:
    def __init__(self, root):
        self.root = root
        self.sequence = 0
        self.failure = None

    async def chat(self, system, user, *, temperature=0.2):
        if self.failure:
            raise RuntimeError(self.failure)
        self.sequence += 1
        request_id = str(self.sequence)
        messages = [{"role": "system", "content": system}, {"role": "user", "content": user}]
        save(self.root, f"snapshots/model-{self.sequence:03d}-request.json",
             {"stage": stage, "messages": messages, "temperature": temperature,
              "originalTemperature": temperature})
        emit("model_request", id=request_id, messages=messages, temperature=temperature)
        response = receive()
        if (response.get("runId") != run_id or response.get("type") != "model_response"
                or response.get("id") != request_id):
            self.failure = "PLATO_PROTOCOL_INVALID: mismatched model response"
            raise RuntimeError(self.failure)
        if response.get("error"):
            self.failure = "PLATO_MODEL_FAILED: " + str(response["error"])
            raise RuntimeError(self.failure)
        text = response.get("text")
        if not isinstance(text, str) or not text.strip():
            self.failure = "PLATO_MODEL_EMPTY: model returned no text"
            raise RuntimeError(self.failure)
        save(self.root, f"snapshots/model-{self.sequence:03d}-response.json",
             {"stage": stage, "text": text, "usage": response.get("usage")})
        return text


def save(root, relative, value, *, binary=False):
    path = (root / relative).resolve()
    path.relative_to(root)
    path.parent.mkdir(parents=True, exist_ok=True)
    if binary:
        path.write_bytes(value)
    else:
        path.write_text(value if isinstance(value, str) else json.dumps(value, ensure_ascii=False, indent=2), encoding="utf-8")
    mime = "image/png" if binary else ("application/json" if path.suffix == ".json" else "text/plain")
    if not relative.startswith("input/"):
        emit("artifact", kind="final" if relative.startswith("final/") else "intermediate",
             name=path.name, relativePath=relative, mime=mime)


async def main():
    global run_id, stage
    request = receive()
    run_id = request.get("runId", "")
    if request.get("type") != "start" or not isinstance(run_id, str) or not run_id:
        raise RuntimeError("PLATO_PROTOCOL_INVALID: expected start and runId")
    text = request.get("requirement_text")
    if not isinstance(text, str) or not text.strip():
        raise ValueError("PLATO_INPUT_EMPTY: requirement_text is required")
    root = Path(request["outputDirectory"]).resolve(strict=True)
    save(root, "input/plato-request.json", {"requirement_text": text, "diagram_type": "activity"})
    emit("ready")  # Only after a real write in this task directory succeeds.

    source = Path(request["sourceRoot"]).resolve(strict=True)
    sys.path.insert(0, str(source))
    os.environ["PLATO_CONFIG_PATH"] = str(Path(__file__).with_name("runtime-config.yaml"))
    # The adapter never opens the user's original backend/config.yaml (it may contain keys).
    from src.core.settings_loader import settings
    settings._data["plantuml"] = {"jar_path": request["plantumlJarPath"], "jar_timeout_s": 30}
    settings._data["java"] = {"cmd": request["javaPath"]}
    from src.core.lato_workflow import LATOWorkflow
    from src.core.plantuml_validator import render_png_with_jar, validate_with_jar
    from src.core.nlp_optional import validate_nlp_runtime

    model = ModelBridge(root)
    workflow = LATOWorkflow(llm=model)
    await validate_nlp_runtime(cfg=workflow.nlp_cfg)
    errors = validate_with_jar("@startuml\nstart\n:preflight;\nstop\n@enduml")
    if errors is None or errors:
        raise RuntimeError("PLATO_PLANTUML_UNAVAILABLE: " + str(errors))

    async def log(message):
        if model.failure:
            raise RuntimeError(model.failure)
        emit("log", stage=stage, message=str(message))

    async def step(name, label, call):
        global stage
        stage = name
        emit("progress", stage=name, stageName=label)
        result = await call()
        if model.failure:
            raise RuntimeError(model.failure)
        return result

    activities = await step("activity_identification", "识别活动", lambda: workflow.identify(text, emit=log))
    save(root, "intermediate/identification.json", activities)
    decomposition = await step("structure_decomposition", "分析控制结构", lambda: workflow.decompose(text, activities=activities, emit=log))
    save(root, "intermediate/decomposition.txt", decomposition)
    if "[Terminated" in decomposition:
        emit("warning", code="PLATO_DECOMPOSITION_LIMIT", message="结构分解达到原算法的层数或重试上限；输出保留终止标记，不代表需求完整。")
    integration = await step("information_integration", "整合信息", lambda: workflow.reconstruct(text, activities=activities, decomposition=decomposition, emit=log))
    save(root, "intermediate/integration.txt", integration)
    plantuml = await step("plantuml_generation", "生成 PlantUML", lambda: workflow.generate(text, integration=integration, emit=log))
    errors = workflow._validate_plantuml(plantuml)
    if errors:
        save(root, "intermediate/invalid-activity.puml", plantuml)
        raise RuntimeError("PLATO_INVALID_UML: " + "; ".join(errors))
    save(root, "final/activity.puml", plantuml)
    stage = "rendering"
    emit("progress", stage=stage, stageName="渲染 PNG 图片")
    png = render_png_with_jar(plantuml, timeout_s=30)
    if not png:
        raise RuntimeError("PLATO_RENDER_FAILED: Java did not produce a PNG")
    save(root, "final/activity.png", png, binary=True)
    emit("result", text="活动图已生成，包含 PlantUML 源码和 PNG 图片。", modelCalls=model.sequence)


if __name__ == "__main__":
    sys.stdin.reconfigure(encoding="utf-8")
    wire.reconfigure(encoding="utf-8")
    sys.stdout = sys.stderr  # Any print in imported algorithms cannot corrupt the protocol.
    try:
        asyncio.run(main())
    except BaseException as error:
        try:
            emit("error", stage=stage, message=f"{type(error).__name__}: {error}"[:4000])
        except Exception:
            pass
        traceback.print_exc(file=sys.stderr)
        sys.exit(1)
