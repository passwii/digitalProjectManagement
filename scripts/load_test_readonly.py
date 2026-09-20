#!/usr/bin/env python3
"""只读 API 压测工具。

示例：
    python3 scripts/load_test_readonly.py \
      --username perfuser \
      --password 'password' \
      --duration 60s \
      --workers 5 \
      --rps 10 \
      --confirm-production

也可以使用已有 access token，避免压测期间重复登录：
    ACCESS_TOKEN='...' python3 scripts/load_test_readonly.py --confirm-production

本脚本只发送一次 POST /auth/login（仅在未提供 ACCESS_TOKEN 时），
压测阶段只发送 GET 请求，不创建、修改、删除或审批业务数据。
"""

from __future__ import annotations

import argparse
import json
import os
import statistics
import sys
import time
from concurrent.futures import ThreadPoolExecutor, as_completed
from dataclasses import dataclass
from http.client import HTTPException
from pathlib import Path
from typing import Iterable
from urllib.error import HTTPError, URLError
from urllib.parse import urlsplit, urlunsplit
from urllib.request import Request, urlopen


DEFAULT_WEB_BASE = "http://145.79.143.98:3001"
DEFAULT_API_BASE = "http://145.79.143.98:8001/api/v1"
PRODUCTION_CONFIRMATION = "I_UNDERSTAND_READ_ONLY"


@dataclass(frozen=True)
class RequestResult:
    name: str
    elapsed: float
    status: int | None
    error: str | None


def parse_duration(value: str) -> float:
    """Parse a small human-friendly duration such as 30s, 2m, or 1h."""
    raw = value.strip().lower()
    if not raw:
        raise ValueError("duration 不能为空")
    suffix = raw[-1]
    multipliers = {"s": 1.0, "m": 60.0, "h": 3600.0}
    if suffix not in multipliers:
        raise ValueError("duration 必须使用 s、m 或 h，例如 30s")
    try:
        seconds = float(raw[:-1]) * multipliers[suffix]
    except ValueError as exc:
        raise ValueError("duration 数值无效") from exc
    if seconds <= 0:
        raise ValueError("duration 必须大于 0")
    return seconds


def percentile(samples: Iterable[float], percent: float) -> float:
    """Return the nearest-rank percentile without requiring numpy."""
    values = sorted(samples)
    if not values:
        return 0.0
    if not 0 <= percent <= 100:
        raise ValueError("percent 必须在 0 到 100 之间")
    index = round((percent / 100) * (len(values) - 1))
    return values[index]


def build_scenarios(project_id: int, include_admin: bool = False) -> list[tuple[str, str]]:
    """Build authenticated read-only endpoints for one representative project."""
    scenarios = [
        ("当前用户", "/auth/me"),
        ("菜单权限", "/meta/me/menus"),
        ("用户字典", "/meta/users"),
        ("部门字典", "/meta/depts"),
        ("工作台汇总", "/dashboard/summary"),
        ("本周动态", "/dashboard/my-weekly"),
        ("通知数量", "/notifications/count"),
        ("项目列表", "/projects?page=1&size=15&sort=-id"),
        ("项目选择器", "/projects/options?page=1&size=20"),
        ("项目详情", f"/projects/{project_id}"),
        ("项目进度", f"/projects/{project_id}/progress"),
        ("项目跟进", f"/projects/{project_id}/followups?page=1&size=20"),
        ("任务列表", f"/tasks?project_id={project_id}&page=1&size=20&sort=-plan_end"),
        ("支出列表", f"/expenses?project_id={project_id}&page=1&size=20&sort=-exp_date"),
        ("成本报表", f"/reports/cost?project_id={project_id}"),
    ]
    if include_admin:
        scenarios.extend(
            [
                ("审批待办", "/approvals/pending?limit=50"),
                ("审计日志", "/admin/logs?page=1&size=20&sort=-id"),
                ("管理员用户列表", "/admin/users?page=1&size=20&sort=-id"),
            ]
        )
    return scenarios


def build_virtual_user_scenarios(
    project_id: int, include_admin: bool = False
) -> list[tuple[str, str]]:
    """Return one page-browsing sequence for a virtual user."""
    return build_scenarios(project_id, include_admin=include_admin)


def _normalise_base(value: str) -> str:
    parsed = urlsplit(value.strip())
    if parsed.scheme not in {"http", "https"} or not parsed.netloc:
        raise ValueError(f"无效 URL：{value}")
    return urlunsplit((parsed.scheme, parsed.netloc, parsed.path.rstrip("/"), "", ""))


def _is_local_host(value: str) -> bool:
    host = (urlsplit(value).hostname or "").lower()
    return host in {"localhost", "127.0.0.1", "::1"}


def _json_request(
    url: str,
    *,
    method: str = "GET",
    token: str | None = None,
    body: dict | None = None,
    timeout: float,
) -> tuple[int, bytes]:
    headers = {
        "Accept": "application/json",
        "User-Agent": "pm-readonly-load-test/1.0",
    }
    payload = None
    if token:
        headers["Authorization"] = f"Bearer {token}"
    if body is not None:
        headers["Content-Type"] = "application/json"
        payload = json.dumps(body).encode("utf-8")
    request = Request(url, data=payload, headers=headers, method=method)
    with urlopen(request, timeout=timeout) as response:
        return response.status, response.read()


def login(api_base: str, username: str, password: str, timeout: float) -> str:
    status, raw = _json_request(
        f"{api_base}/auth/login",
        method="POST",
        body={"username": username, "password": password},
        timeout=timeout,
    )
    if status != 200:
        raise RuntimeError(f"登录失败：HTTP {status}")
    try:
        token = json.loads(raw)["access_token"]
    except (KeyError, TypeError, json.JSONDecodeError) as exc:
        raise RuntimeError("登录响应中没有 access_token") from exc
    return str(token)


def discover_project_id(api_base: str, token: str, timeout: float) -> int:
    status, raw = _json_request(
        f"{api_base}/projects?page=1&size=1&sort=-id",
        token=token,
        timeout=timeout,
    )
    if status != 200:
        raise RuntimeError(f"项目发现失败：HTTP {status}")
    try:
        payload = json.loads(raw)
        items = payload.get("items", payload if isinstance(payload, list) else [])
        project_id = items[0]["id"] if items else 0
        return int(project_id)
    except (KeyError, TypeError, ValueError, json.JSONDecodeError) as exc:
        raise RuntimeError("项目列表响应格式无法识别") from exc


def _request_one(
    api_base: str,
    token: str,
    name: str,
    path: str,
    timeout: float,
) -> RequestResult:
    started = time.perf_counter()
    try:
        status, _ = _json_request(f"{api_base}{path}", token=token, timeout=timeout)
        return RequestResult(name, time.perf_counter() - started, status, None)
    except HTTPError as exc:
        return RequestResult(name, time.perf_counter() - started, exc.code, f"HTTP {exc.code}")
    except (HTTPException, TimeoutError, URLError, OSError) as exc:
        return RequestResult(name, time.perf_counter() - started, None, type(exc).__name__)
    except Exception as exc:  # pragma: no cover - last-resort network guard
        return RequestResult(name, time.perf_counter() - started, None, type(exc).__name__)


def _worker(
    api_base: str,
    token: str,
    scenarios: list[tuple[str, str]],
    deadline: float,
    timeout: float,
    interval: float,
    worker_index: int,
) -> list[RequestResult]:
    results: list[RequestResult] = []
    cursor = worker_index % len(scenarios)
    next_start = time.perf_counter()
    while time.perf_counter() < deadline:
        if interval:
            wait = next_start - time.perf_counter()
            if wait > 0:
                time.sleep(wait)
        name, path = scenarios[cursor]
        results.append(_request_one(api_base, token, name, path, timeout))
        cursor = (cursor + 1) % len(scenarios)
        if interval:
            next_start = max(next_start + interval, time.perf_counter())
    return results


def _virtual_user_worker(
    api_base: str,
    token: str,
    scenarios: list[tuple[str, str]],
    deadline: float,
    timeout: float,
    think_time: float,
) -> list[RequestResult]:
    """Simulate one user browsing pages in order with a small reading pause."""
    results: list[RequestResult] = []
    cursor = 0
    while time.perf_counter() < deadline:
        name, path = scenarios[cursor]
        results.append(_request_one(api_base, token, name, path, timeout))
        cursor = (cursor + 1) % len(scenarios)
        if time.perf_counter() < deadline and think_time:
            time.sleep(think_time)
    return results


def _print_report(results: list[RequestResult], elapsed: float) -> None:
    grouped: dict[str, list[RequestResult]] = {}
    for result in results:
        grouped.setdefault(result.name, []).append(result)
    successes = sum(1 for result in results if result.status is not None and 200 <= result.status < 300)
    failures = len(results) - successes
    print("\n压测结果")
    print(f"总请求数：{len(results)}，成功：{successes}，失败：{failures}，实际 RPS：{len(results) / max(elapsed, 0.001):.2f}")
    print(f"{'接口':<18}{'请求数':>8}{'成功率':>10}{'P50':>10}{'P95':>10}{'P99':>10}{'错误':>12}")
    print("-" * 80)
    for name, rows in grouped.items():
        samples = [row.elapsed for row in rows]
        ok = sum(1 for row in rows if row.status is not None and 200 <= row.status < 300)
        errors: dict[str, int] = {}
        for row in rows:
            if row.error:
                errors[row.error] = errors.get(row.error, 0) + 1
        error_text = ",".join(f"{key}:{value}" for key, value in errors.items()) or "-"
        print(
            f"{name:<18}{len(rows):>8}{ok / len(rows):>9.1%}"
            f"{percentile(samples, 50):>9.3f}s{percentile(samples, 95):>9.3f}s"
            f"{percentile(samples, 99):>9.3f}s{error_text:>12}"
        )


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description="项目管理系统只读 API 压测")
    parser.add_argument("--api-base", default=os.getenv("API_BASE", DEFAULT_API_BASE))
    parser.add_argument("--web-base", default=os.getenv("WEB_BASE", DEFAULT_WEB_BASE), help="仅用于生产确认提示")
    parser.add_argument("--token", default=os.getenv("ACCESS_TOKEN", ""))
    parser.add_argument("--username", default=os.getenv("LOAD_TEST_USERNAME", ""))
    parser.add_argument("--password", default=os.getenv("LOAD_TEST_PASSWORD", ""))
    parser.add_argument("--duration", default="30s", help="压测时长，例如 30s、5m")
    parser.add_argument("--workers", type=int, default=2, help="并发工作线程，默认 2")
    parser.add_argument(
        "--users",
        type=int,
        default=0,
        help="虚拟用户数；大于 0 时每个用户按页面顺序独立循环",
    )
    parser.add_argument(
        "--think-time",
        type=float,
        default=1.0,
        help="虚拟用户每次请求后的阅读/点击间隔秒数，默认 1 秒",
    )
    parser.add_argument("--rps", type=float, default=5.0, help="总目标 RPS，默认 5；0 表示不主动限速")
    parser.add_argument("--timeout", type=float, default=10.0, help="单请求超时秒数")
    parser.add_argument("--project-id", type=int, default=0, help="指定测试项目 ID，0 表示自动读取一个项目")
    parser.add_argument("--admin", action="store_true", help="加入管理员只读接口；账号必须有管理员权限")
    parser.add_argument("--confirm-production", action="store_true", help="确认只读压测生产地址")
    return parser


def main(argv: list[str] | None = None) -> int:
    args = build_parser().parse_args(argv)
    try:
        duration = parse_duration(args.duration)
        api_base = _normalise_base(args.api_base)
        web_base = _normalise_base(args.web_base)
    except ValueError as exc:
        print(f"参数错误：{exc}", file=sys.stderr)
        return 2
    if args.workers < 1 or args.workers > 50:
        print("参数错误：workers 必须在 1 到 50 之间", file=sys.stderr)
        return 2
    if args.users < 0 or args.users > 50:
        print("参数错误：users 必须在 0 到 50 之间", file=sys.stderr)
        return 2
    if args.think_time < 0:
        print("参数错误：think-time 不能小于 0", file=sys.stderr)
        return 2
    if args.rps < 0:
        print("参数错误：rps 不能小于 0", file=sys.stderr)
        return 2
    if not _is_local_host(api_base) and not args.confirm_production:
        print(
            "拒绝执行：目标不是本机地址。只读生产压测必须显式添加 --confirm-production，"
            f"并确认目标为 {web_base}。",
            file=sys.stderr,
        )
        return 2
    token = args.token.strip()
    if not token:
        if not args.username or not args.password:
            print("请提供 --token，或同时提供 --username 和 --password", file=sys.stderr)
            return 2
        print("正在登录一次以获取访问令牌……")
        try:
            token = login(api_base, args.username, args.password, args.timeout)
        except Exception as exc:
            print(f"登录失败：{exc}", file=sys.stderr)
            return 1
    if args.project_id:
        project_id = args.project_id
    else:
        try:
            project_id = discover_project_id(api_base, token, args.timeout)
        except Exception as exc:
            print(f"读取项目 ID 失败：{exc}", file=sys.stderr)
            return 1
    scenarios = build_virtual_user_scenarios(project_id, include_admin=args.admin)
    interval = args.workers / args.rps if args.rps else 0.0
    concurrency = args.users or args.workers
    mode = (
        f"{args.users} 个虚拟用户，思考间隔 {args.think_time:.1f}s"
        if args.users
        else f"{args.workers} 个请求工作线程，目标 {args.rps or '不主动限速'} RPS"
    )
    print(
        f"目标 API：{api_base}\n"
        f"模式：只读，接口数：{len(scenarios)}，项目 ID：{project_id}\n"
        f"并发模式：{mode}\n"
        f"时长：{args.duration}，超时：{args.timeout}s"
    )
    print("开始压测；如需停止请按 Ctrl-C。")
    started = time.perf_counter()
    deadline = started + duration
    results: list[RequestResult] = []
    try:
        with ThreadPoolExecutor(max_workers=concurrency, thread_name_prefix="load") as pool:
            if args.users:
                futures = [
                    pool.submit(
                        _virtual_user_worker,
                        api_base,
                        token,
                        scenarios,
                        deadline,
                        args.timeout,
                        args.think_time,
                    )
                    for _ in range(args.users)
                ]
            else:
                futures = [
                    pool.submit(
                        _worker,
                        api_base,
                        token,
                        scenarios,
                        deadline,
                        args.timeout,
                        interval,
                        worker_index,
                    )
                    for worker_index in range(args.workers)
                ]
            for future in as_completed(futures):
                results.extend(future.result())
    except KeyboardInterrupt:
        print("\n收到停止信号，正在汇总已完成请求……")
    elapsed = time.perf_counter() - started
    _print_report(results, elapsed)
    return 0 if results and any(row.status and 200 <= row.status < 300 for row in results) else 1


if __name__ == "__main__":
    raise SystemExit(main())
