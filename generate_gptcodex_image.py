from __future__ import annotations

import base64
import json
import os
import queue
import re
import subprocess
import sys
import time
import tempfile
import threading
from dataclasses import dataclass
from pathlib import Path
from typing import Iterable, Optional


BASE_URL = "https://gptcodex.top"
TEXT_MODEL = "gpt-5.5"
IMAGE_MODEL = "gpt-image-2"
IMAGE_SIZE = "1024x1024"
DEFAULT_QUALITY = "auto"
OUTPUT_FORMAT = "png"
OUTPUT_DIR = Path(__file__).resolve().parent / "images"
STATUS_INTERVAL_SECONDS = 10
MAX_ATTEMPTS = 3
RETRY_BACKOFF_SECONDS = 15
MAX_INPUT_IMAGE_BYTES = 50 * 1024 * 1024

SUPPORTED_IMAGE_MIME_TYPES = {
    ".png": "image/png",
    ".jpg": "image/jpeg",
    ".jpeg": "image/jpeg",
    ".webp": "image/webp",
}

SIZE_OPTIONS = {
    "1": ("正方形 1024x1024", "1024x1024"),
    "2": ("横版 1536x1024", "1536x1024"),
    "3": ("竖版 1024x1536", "1024x1536"),
    "4": ("宽屏 2048x1152", "2048x1152"),
}

QUALITY_OPTIONS = {
    "1": ("标准 auto（推荐）", "auto"),
    "2": ("高质量 high", "high"),
    "3": ("中等 medium", "medium"),
    "4": ("快速草稿 low", "low"),
}


@dataclass(frozen=True)
class ImageResult:
    image_b64: str
    revised_prompt: str = ""
    source_event: str = "final"


def build_payload(
    prompt: str,
    *,
    size: str = IMAGE_SIZE,
    quality: str = DEFAULT_QUALITY,
    image_data_url: Optional[str] = None,
) -> dict:
    content = [
        {
            "type": "input_text",
            "text": prompt,
        }
    ]
    action = "generate"
    if image_data_url:
        content.append(
            {
                "type": "input_image",
                "image_url": image_data_url,
            }
        )
        action = "edit"

    return {
        "model": TEXT_MODEL,
        "input": [
            {
                "role": "user",
                "content": content,
            }
        ],
        "tools": [
            {
                "type": "image_generation",
                "model": IMAGE_MODEL,
                "action": action,
                "size": size,
                "quality": quality,
                "output_format": OUTPUT_FORMAT,
                "moderation": "low",
                "partial_images": 0,
            }
        ],
        "tool_choice": {"type": "image_generation"},
        "reasoning": {"effort": "xhigh"},
        "store": False,
        "stream": True,
    }


def slugify(text: str, *, fallback: str = "image") -> str:
    text = re.sub(r"[^\w\u4e00-\u9fff]+", "-", text.strip().lower(), flags=re.UNICODE)
    text = re.sub(r"-{2,}", "-", text).strip("-")
    return text[:40] or fallback


def normalize_path_input(raw_path: str) -> Path:
    cleaned = raw_path.strip().strip('"').strip("'")
    if not cleaned:
        raise ValueError("图片路径不能为空。")
    return Path(cleaned).expanduser()


def image_file_to_data_url(image_path: Path) -> str:
    path = Path(image_path)
    if not path.exists() or not path.is_file():
        raise ValueError(f"找不到图片文件：{path}")

    mime_type = SUPPORTED_IMAGE_MIME_TYPES.get(path.suffix.lower())
    if not mime_type:
        supported = ", ".join(sorted(SUPPORTED_IMAGE_MIME_TYPES))
        raise ValueError(f"不支持的图片格式：{path.suffix or '(无扩展名)'}。支持：{supported}")

    size = path.stat().st_size
    if size > MAX_INPUT_IMAGE_BYTES:
        raise ValueError("图片文件超过 50MB，请换一张更小的图片。")

    encoded = base64.b64encode(path.read_bytes()).decode("ascii")
    return f"data:{mime_type};base64,{encoded}"


def iter_sse_events(raw_text: str) -> Iterable[dict]:
    for line in raw_text.splitlines():
        if not line.startswith("data: "):
            continue
        payload = line[6:].strip()
        if not payload or payload == "[DONE]":
            continue
        try:
            yield json.loads(payload)
        except json.JSONDecodeError:
            continue


def extract_image_result_from_sse(raw_text: str) -> ImageResult:
    partial_b64: Optional[str] = None
    partial_prompt = ""

    for event in iter_sse_events(raw_text):
        event_type = event.get("type")

        if event_type == "response.image_generation_call.partial_image":
            partial_b64 = event.get("partial_image_b64") or partial_b64
            partial_prompt = event.get("revised_prompt") or partial_prompt
            continue

        if event_type != "response.output_item.done":
            continue

        item = event.get("item") or {}
        if item.get("type") != "image_generation_call":
            continue

        result_b64 = item.get("result")
        if result_b64:
            return ImageResult(
                image_b64=result_b64,
                revised_prompt=item.get("revised_prompt") or "",
                source_event="final",
            )

        if partial_b64:
            return ImageResult(
                image_b64=partial_b64,
                revised_prompt=partial_prompt,
                source_event="partial",
            )

    json_result = find_image_result_in_json(raw_text)
    if json_result:
        return json_result

    if partial_b64:
        return ImageResult(
            image_b64=partial_b64,
            revised_prompt=partial_prompt,
            source_event="partial",
        )

    raise ValueError("没有在接口返回内容中找到图片 base64。")


def find_image_result_in_json(raw_text: str) -> Optional[ImageResult]:
    try:
        data = json.loads(raw_text)
    except json.JSONDecodeError:
        return None

    found = find_image_call(data)
    if not found:
        return None

    return ImageResult(
        image_b64=found.get("result", ""),
        revised_prompt=found.get("revised_prompt") or "",
        source_event="json",
    )


def find_image_call(value) -> Optional[dict]:
    if isinstance(value, dict):
        if value.get("type") == "image_generation_call" and value.get("result"):
            return value
        for child in value.values():
            found = find_image_call(child)
            if found:
                return found
    elif isinstance(value, list):
        for child in value:
            found = find_image_call(child)
            if found:
                return found
    return None


def describe_response_problem(raw_text: str) -> str:
    text = raw_text.strip()
    if not text:
        return "接口返回为空。"

    lower_text = text.lower()
    if "error code 524" in lower_text or "524: a timeout occurred" in lower_text:
        return "Cloudflare 524：源站在超时时间内没有返回有效响应。"
    if "error code 504" in lower_text or "gateway time-out" in lower_text:
        return "Cloudflare 504：源站网关超时。"

    try:
        data = json.loads(text)
    except json.JSONDecodeError:
        data = None

    if isinstance(data, dict):
        status = data.get("status")
        error_name = data.get("error_name")
        if status in (504, 524) or error_name in {"origin_gateway_timeout", "timeout"}:
            return f"接口返回 {status or error_name}：上游服务超时。"
        error = data.get("error")
        if isinstance(error, dict):
            return f"接口返回错误：{error.get('message') or error}"
        if data.get("message"):
            return f"接口返回消息：{data.get('message')}"

    for event in iter_sse_events(raw_text):
        response = event.get("response") or {}
        error = response.get("error") or event.get("error")
        if error:
            return f"接口返回错误：{error}"

    return "接口已返回内容，但没有发现 image_generation_call.result。"


def is_retryable_response(raw_text: str) -> bool:
    text = raw_text.strip()
    lower_text = text.lower()
    retryable_markers = (
        "error code 524",
        "524: a timeout occurred",
        "error code 504",
        "gateway time-out",
        "service temporarily unavailable",
        "origin_gateway_timeout",
    )
    if any(marker in lower_text for marker in retryable_markers):
        return True

    try:
        data = json.loads(text)
    except json.JSONDecodeError:
        return False

    if not isinstance(data, dict):
        return False
    if data.get("retryable") is True:
        return True
    if data.get("status") in (502, 503, 504, 524):
        return True
    error = data.get("error")
    if isinstance(error, dict):
        message = str(error.get("message") or "").lower()
        error_type = str(error.get("type") or "").lower()
        return "temporarily unavailable" in message or error_type in {"api_error", "server_error"}
    return False


def format_bytes(size: int) -> str:
    if size < 1024:
        return f"{size} B"
    if size < 1024 * 1024:
        return f"{size / 1024:.1f} KB"
    return f"{size / 1024 / 1024:.1f} MB"


def summarize_sse_line(line: str) -> Optional[str]:
    stripped = line.strip()
    if not stripped:
        return None
    if stripped.startswith(":"):
        return "收到接口保活信号"
    if not stripped.startswith("data: "):
        return None

    payload = stripped[6:].strip()
    try:
        event = json.loads(payload)
    except json.JSONDecodeError:
        return None

    event_type = event.get("type")
    if event_type == "response.created":
        return "请求已创建"
    if event_type == "response.in_progress":
        return "模型处理中"
    if event_type == "response.image_generation_call.in_progress":
        return "图片工具已启动"
    if event_type == "response.image_generation_call.generating":
        return "图片正在生成"
    if event_type == "response.image_generation_call.partial_image":
        return "已收到图片数据片段"
    if event_type == "response.output_item.done":
        item = event.get("item") or {}
        if item.get("type") == "image_generation_call" and item.get("result"):
            return "图片生成完成，正在保存"
        if item.get("type") == "image_generation_call":
            return f"图片工具状态：{item.get('status') or '未知'}"
    if event_type == "response.completed":
        return "接口已完成"
    if event_type:
        return f"接口事件：{event_type}"
    return None


def copy_stream_to_file(process, raw_response_path: Path, lines: "queue.Queue[str]") -> None:
    with raw_response_path.open("w", encoding="utf-8", errors="replace", newline="") as output:
        try:
            os.chmod(raw_response_path, 0o600)
        except OSError:
            pass
        assert process.stdout is not None
        for line in process.stdout:
            output.write(line)
            output.flush()
            lines.put(line)


def build_curl_config(api_key: str) -> str:
    headers = [
        "Accept: */*",
        "Content-Type: application/json",
        f"Authorization: Bearer {api_key}",
    ]
    return "".join(f'header = "{header}"\n' for header in headers)


def build_curl_command(request_body_path: Path, config_path: Path) -> list[str]:
    return [
        "curl.exe",
        "-sS",
        "--no-progress-meter",
        "-N",
        "--http1.1",
        "--ssl-no-revoke",
        "--connect-timeout",
        "30",
        "--max-time",
        "600",
        "-X",
        "POST",
        f"{BASE_URL}/v1/responses",
        "--config",
        str(config_path),
        "--data-binary",
        f"@{request_body_path}",
    ]


def request_image_with_curl(
    api_key: str,
    prompt: str,
    *,
    size: str,
    quality: str,
    image_data_url: Optional[str],
    raw_response_path: Path,
    status_interval_seconds: int = STATUS_INTERVAL_SECONDS,
) -> str:
    request_body = json.dumps(
        build_payload(prompt, size=size, quality=quality, image_data_url=image_data_url),
        ensure_ascii=False,
    )
    with tempfile.NamedTemporaryFile(
        "w",
        encoding="utf-8",
        delete=False,
        dir=raw_response_path.parent,
        suffix=".request.json",
    ) as tmp:
        request_body_path = Path(tmp.name)
        tmp.write(request_body)

    with tempfile.NamedTemporaryFile(
        "w",
        encoding="utf-8",
        delete=False,
        dir=raw_response_path.parent,
        suffix=".headers.cfg",
    ) as tmp_cfg:
        config_path = Path(tmp_cfg.name)
        tmp_cfg.write(build_curl_config(api_key))
    try:
        os.chmod(config_path, 0o600)
    except OSError:
        pass

    command = build_curl_command(request_body_path, config_path)

    process = subprocess.Popen(
        command,
        text=True,
        encoding="utf-8",
        errors="replace",
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
    )

    lines: "queue.Queue[str]" = queue.Queue()
    reader = threading.Thread(
        target=copy_stream_to_file,
        args=(process, raw_response_path, lines),
        daemon=True,
    )
    reader.start()

    started = time.monotonic()
    last_report = started
    last_status = "等待接口响应"
    while process.poll() is None or not lines.empty():
        try:
            line = lines.get(timeout=1)
            summary = summarize_sse_line(line)
            if summary:
                last_status = summary
        except queue.Empty:
            pass

        now = time.monotonic()
        if now - last_report >= status_interval_seconds:
            elapsed = int(now - started)
            received = raw_response_path.stat().st_size if raw_response_path.exists() else 0
            print(f"已等待 {elapsed} 秒，状态：{last_status}，已接收 {format_bytes(received)}...")
            last_report = now

    reader.join(timeout=5)
    stdout, stderr = process.communicate()
    request_body_path.unlink(missing_ok=True)
    config_path.unlink(missing_ok=True)

    if process.returncode != 0:
        stderr = (stderr or "").strip() or (stdout or "").strip() or "curl.exe 未返回错误详情。"
        raise RuntimeError(f"curl.exe 请求失败，退出码 {process.returncode}：{stderr}")

    if not raw_response_path.exists():
        raise RuntimeError("curl.exe 没有生成返回文件。")

    return raw_response_path.read_text(encoding="utf-8", errors="replace")


def request_and_extract_with_retries(
    api_key: str,
    prompt: str,
    *,
    size: str,
    quality: str,
    image_data_url: Optional[str],
    output_dir: Path,
    timestamp: str,
) -> tuple[ImageResult, Path]:
    last_error: Optional[Exception] = None
    last_raw_path: Optional[Path] = None

    for attempt in range(1, MAX_ATTEMPTS + 1):
        raw_response_path = output_dir / f"gptcodex-response-{timestamp}-attempt{attempt}.txt"
        last_raw_path = raw_response_path
        print(f"第 {attempt}/{MAX_ATTEMPTS} 次请求...")

        try:
            raw_stream = request_image_with_curl(
                api_key,
                prompt,
                size=size,
                quality=quality,
                image_data_url=image_data_url,
                raw_response_path=raw_response_path,
            )
            return extract_image_result_from_sse(raw_stream), raw_response_path
        except ValueError as exc:
            last_error = exc
            raw_text = raw_response_path.read_text(encoding="utf-8", errors="replace") if raw_response_path.exists() else ""
            reason = describe_response_problem(raw_text)
            if attempt < MAX_ATTEMPTS and is_retryable_response(raw_text):
                print(f"{reason}")
                print(f"这是可重试错误，{RETRY_BACKOFF_SECONDS} 秒后自动重试...")
                time.sleep(RETRY_BACKOFF_SECONDS)
                continue
            raise RuntimeError(f"{reason}\n原始返回已保存：{raw_response_path.resolve()}") from exc
        except RuntimeError as exc:
            last_error = exc
            if attempt < MAX_ATTEMPTS:
                print(f"{exc}")
                print(f"{RETRY_BACKOFF_SECONDS} 秒后自动重试...")
                time.sleep(RETRY_BACKOFF_SECONDS)
                continue
            raise

    if last_raw_path:
        raise RuntimeError(f"多次请求后仍未成功。最后一次原始返回：{last_raw_path.resolve()}") from last_error
    raise RuntimeError("多次请求后仍未成功。") from last_error


def save_image(image_b64: str, output_path: Path) -> Path:
    output_path.write_bytes(base64.b64decode(image_b64))
    try:
        os.chmod(output_path, 0o600)
    except OSError:
        pass
    return output_path.resolve()


def prompt_for_key() -> str:
    print("请输入 API Key。")
    print("注意：请先在 GPTCODEX 中转站后台，把这个 key 选择为“余额分组”或“套餐分组”，不用选择 image-2 分组。")
    key = input("API Key: ").strip()
    if not key:
        raise ValueError("API Key 不能为空。")
    return key


def prompt_for_mode() -> str:
    print("请选择生成模式：")
    print("  1. 文生图（只输入提示词）")
    print("  2. 图生图 / 编辑图片（输入原图路径 + 修改要求）")
    choice = input("输入 1 或 2: ").strip()
    if choice == "1":
        return "generate"
    if choice == "2":
        return "edit"
    raise ValueError("模式选择无效，只能输入 1 或 2。")


def prompt_for_image_path() -> Path:
    raw_path = input(r"请输入要修改的图片路径，例如 E:\photos\图片名.png: ")
    return normalize_path_input(raw_path)


def prompt_for_size() -> str:
    print("请选择图片比例：")
    for key, (label, _) in SIZE_OPTIONS.items():
        print(f"  {key}. {label}")
    choice = input("输入 1-4: ").strip()
    if choice not in SIZE_OPTIONS:
        raise ValueError("比例选择无效。")
    return SIZE_OPTIONS[choice][1]


def prompt_for_quality() -> str:
    print("请选择生成质量：")
    for key, (label, _) in QUALITY_OPTIONS.items():
        print(f"  {key}. {label}")
    choice = input("输入 1-4: ").strip()
    if choice not in QUALITY_OPTIONS:
        raise ValueError("质量选择无效。")
    return QUALITY_OPTIONS[choice][1]


def prompt_for_text(mode: str) -> str:
    label = "请输入修改要求: " if mode == "edit" else "请输入提示词: "
    prompt = input(label).strip()
    if not prompt:
        raise ValueError("提示词/修改要求不能为空。")
    return prompt


def main() -> int:
    print("GPTCODEX 图片生成器")
    print()

    try:
        api_key = prompt_for_key()
        mode = prompt_for_mode()
        image_data_url: Optional[str] = None
        source_image_path: Optional[Path] = None
        if mode == "edit":
            source_image_path = prompt_for_image_path()
            image_data_url = image_file_to_data_url(source_image_path)

        size = prompt_for_size()
        quality = prompt_for_quality()
        prompt = prompt_for_text(mode)

        timestamp = time.strftime("%Y%m%d-%H%M%S")
        output_dir = OUTPUT_DIR
        output_dir.mkdir(parents=True, mode=0o700, exist_ok=True)

        print()
        action_label = "编辑图片" if mode == "edit" else "生成图片"
        print(f"正在请求{action_label}，比例 {size}，质量 {quality}...")
        if source_image_path:
            print(f"源图片：{source_image_path.resolve()}")
        result, raw_response_path = request_and_extract_with_retries(
            api_key,
            prompt,
            size=size,
            quality=quality,
            image_data_url=image_data_url,
            output_dir=output_dir,
            timestamp=timestamp,
        )

        prefix = "edit" if mode == "edit" else "generate"
        image_name = f"gptcodex-{prefix}-{slugify(prompt)}-{timestamp}.{OUTPUT_FORMAT}"
        image_path = save_image(result.image_b64, output_dir / image_name)

        print(f"图片已保存：{image_path}")
        print(f"原始返回已保存：{raw_response_path.resolve()}")
        if result.revised_prompt:
            print(f"修订提示词：{result.revised_prompt}")
        return 0

    except KeyboardInterrupt:
        print("\n已取消。")
        return 1
    except Exception as exc:
        print(f"发生错误：{exc}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
