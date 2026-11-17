"""Server-side daily check-in.

The server checks in once a day on its own (a scheduler thread), so it happens even when no page is
open. Browsers only read the state, switch auto check-in on or off and ask for a manual check-in.

JM switches its check-in day at UTC+8 midnight. Failed automatic tries back off (10 min, 30 min, 90 min,
a refusal waits at least an hour) and stop for the day after a few: repeated tries are what make JM
refuse. A check-in POST whose answer was lost may still have counted; a later try then only reports
"already checked in".
"""

from __future__ import annotations

import json
import re
import threading
import time
from pathlib import Path

from local_library import atomic_json_write

SCHEDULE_FIRST_DELAY = 20
SCHEDULE_TICK = 10 * 60
RETRY_INTERVAL = 10 * 60
REFUSED_DELAY = 60 * 60
MAX_DELAY = 6 * 60 * 60
MAX_AUTO_FAILURES = 4

REWARD_PATTERN = re.compile(r"\[?\s*(J?COINS?|EXP)\s*[:：]\s*(\d+)\s*\]?", re.IGNORECASE)
FAILED_MESSAGE = re.compile(
    r"失败|失敗|错误|錯誤|异常|異常|未登录|未登入|请先|請先|无法|無法|尚未|未能|没有|沒有|未成功|未签到|未簽到|不成功"
    r"|not\s+(?:successful|checked)|fail(?:ed|ure)?|error|denied",
    re.IGNORECASE,
)
ALREADY_MESSAGE = re.compile(r"已(?:经|經)?(?:完成)?[签簽]到|[签簽]到[过過]|[重複复]{2}[签簽]到|already\s+checked[ -]?in", re.IGNORECASE)
SUCCESS_MESSAGE = re.compile(r"签到成功|簽到成功|check[ -]?in\s+(?:succeeded|successful)", re.IGNORECASE)


class CheckInError(RuntimeError):
    """`refused`: JM turned the request away (HTTP 403/429) before handling it."""

    def __init__(self, message: str, refused: bool = False) -> None:
        super().__init__(message)
        self.refused = refused


def now_ms() -> int:
    return int(time.time() * 1000)


def check_in_day(timestamp: float | None = None) -> str:
    return time.strftime("%Y-%m-%d", time.gmtime((time.time() if timestamp is None else timestamp) + 8 * 3600))


def account_key(username: object) -> str:
    return str(username or "").strip().lower()


def message_of(value: object) -> str:
    if isinstance(value, str):
        return value.strip()
    if not isinstance(value, dict):
        return ""
    return "；".join(item.strip() for item in (value.get("msg"), value.get("message"), value.get("error")) if isinstance(item, str) and item.strip())


def is_empty(value: object) -> bool:
    return value is None or value == "" or (isinstance(value, (dict, list)) and not value)


def reward_text(kind: str, amount: str) -> str:
    return f"{amount} {'经验' if 'exp' in kind.lower() else '金币'}"


def error_detail(error: Exception) -> str:
    if getattr(error, "refused", False):
        return f"{error}，请过一段时间再试"
    text = str(error) or "未收到有效响应"
    return "请求超时" if re.search(r"timeout|timed out", text, re.IGNORECASE) else text


class DailyCheckIn:
    """
    `account() -> {"username", "password"}` reads the configured account.
    `login(refresh) -> profile` makes sure there is a login session (`refresh=True` logs in again) and
    returns its profile ({"uid", ...}).
    `call(path, method, fields) -> (envelope, result)` makes an authenticated JM API request and returns
    the JSON envelope and its decrypted `data`. It raises `CheckInError` (refused=True for 403/429);
    a POST whose answer was lost raises something else.
    """

    def __init__(self, state_file: Path, account, login, call, sleep=time.sleep) -> None:
        self.state_file = state_file
        self.account = account
        self.login = login
        self.call = call
        self.sleep = sleep
        self.lock = threading.Lock()
        self.thread: threading.Thread | None = None
        self.scheduler: threading.Thread | None = None

    # ----- stored state -----

    def _read(self) -> dict:
        try:
            data = json.loads(self.state_file.read_text(encoding="utf-8"))
        except (OSError, ValueError):
            data = {}
        return data if isinstance(data, dict) else {}

    def _write(self, state: dict) -> None:
        atomic_json_write(self.state_file, state)

    def _today(self, state: dict) -> dict:
        """Today's record for the configured account, or an empty one."""
        record = state.get("today")
        if (
            isinstance(record, dict)
            and record.get("day") == check_in_day()
            and record.get("account") == account_key(self.account().get("username"))
        ):
            return record
        return {}

    # ----- shown to browsers -----

    def status(self) -> dict:
        with self.lock:
            return self._status()

    def _status(self) -> dict:
        state = self._read()
        today = self._today(state)
        failures = int(today.get("failures") or 0)
        return {
            "enabled": state.get("enabled") is not False,
            "configured": bool(account_key(self.account().get("username"))),
            "running": self.thread is not None,
            "day": check_in_day(),
            "done": bool(today.get("done")),
            "result": today.get("result"),
            "failures": failures,
            "retryAt": int(today.get("retryAt") or 0),
            "gaveUp": failures >= MAX_AUTO_FAILURES and not today.get("done"),
        }

    def set_enabled(self, enabled: bool) -> dict:
        with self.lock:
            state = self._read()
            state["enabled"] = bool(enabled)
            self._write(state)
            return self._status()

    # ----- starting check-ins -----

    def request(self, auto: bool = False) -> dict:
        """Start a check-in in the background (manual unless `auto`) and answer at once."""
        with self.lock:
            if self.thread is None and (not auto or self._due()):
                self.thread = threading.Thread(target=self._work, args=(auto,), name="daily-checkin", daemon=True)
                self.thread.start()
            return self._status()

    def _due(self) -> bool:
        state = self._read()
        if state.get("enabled") is False or not account_key(self.account().get("username")):
            return False
        today = self._today(state)
        if today.get("done") or int(today.get("failures") or 0) >= MAX_AUTO_FAILURES:
            return False
        return now_ms() >= int(today.get("retryAt") or 0)

    def start_scheduler(self) -> None:
        if self.scheduler is not None:
            return

        def loop() -> None:
            self.sleep(SCHEDULE_FIRST_DELAY)
            while True:
                try:
                    self.request(auto=True)
                except Exception as error:  # Keep scheduling after an unexpected failure.
                    print(f"自动签到调度失败: {error}")
                self.sleep(SCHEDULE_TICK)

        self.scheduler = threading.Thread(target=loop, name="daily-checkin-schedule", daemon=True)
        self.scheduler.start()

    # ----- the worker -----

    def _work(self, auto: bool) -> None:
        username = account_key(self.account().get("username"))
        try:
            outcome = self.check_in()
            failed = False
        except Exception as error:
            outcome = {"status": "failed", "message": str(error) or "签到失败，请稍后重试"}
            failed = True
            refused = getattr(error, "refused", False)
        with self.lock:
            try:
                state = self._read()
                today = self._today(state) if username == account_key(self.account().get("username")) else {}
                today = {**today, "day": check_in_day(), "account": username}
                if failed and auto:
                    count = int(today.get("failures") or 0) + 1
                    backoff = RETRY_INTERVAL * 3 ** (count - 1)
                    delay = min(MAX_DELAY, max(REFUSED_DELAY, backoff) if refused else backoff)
                    today.update(failures=count, retryAt=now_ms() + delay * 1000)
                    if count >= MAX_AUTO_FAILURES:
                        outcome["message"] += "。今天不再自动重试，可稍后手动签到"
                elif not failed:
                    today.update(done=True, failures=0, retryAt=0)
                today["result"] = {**outcome, "auto": auto, "at": now_ms()}
                state["today"] = today
                self._write(state)
            except OSError as error:
                print(f"签到状态保存失败: {error}")
            finally:
                self.thread = None
        print(f"{'自动' if auto else '手动'}签到：{outcome['message']}")

    def check_in(self) -> dict:
        """Check in once; returns {"status": "success" | "already", "message"} or raises."""
        uid = str((self.login(False) or {}).get("uid") or "")
        outcome = self._attempt(uid, relogged=False)
        if outcome is not None:
            return outcome
        # JM answers code 200 with an empty body (not 401) once the login cookie expired or was replaced
        # by a login elsewhere. Log in again and retry once: a repeated check-in only says "already".
        try:
            fresh = str((self.login(True) or {}).get("uid") or "")
        except Exception as error:
            raise CheckInError(f"登录凭证已失效（可能已过期或在其他地方登录），重新登录失败，签到未完成：{error_detail(error)}") from error
        if fresh != uid:
            raise CheckInError("重新登录后的账号与当前账号不一致，签到未完成")
        return self._attempt(uid, relogged=True)

    def _attempt(self, uid: str, relogged: bool) -> dict | None:
        try:
            if not re.fullmatch(r"\d+", uid):
                raise CheckInError("账号 ID 无效")
            envelope, result = self.call(f"/daily?user_id={uid}", "GET", None)
            self._assert_envelope(envelope)
            if is_empty(result) and not message_of(envelope):
                if not relogged:
                    return None
                raise CheckInError("未取得签到活动信息，请稍后重试")
            if not isinstance(result, dict):
                raise CheckInError("未取得签到活动信息，请稍后重试")
            daily_id = str(result.get("daily_id") or "").strip()
            if not re.fullmatch(r"\d+", daily_id) or int(daily_id) <= 0:
                raise CheckInError(str(result.get("msg") or result.get("message") or "未取得签到活动 ID，请稍后重试").strip())
        except Exception as error:
            prefix = "登录凭证已失效，重新登录后" if relogged else ""
            raise CheckInError(f"{prefix}读取签到活动失败，尚未提交签到：{error_detail(error)}", getattr(error, "refused", False)) from error

        try:
            envelope, result = self.call("/daily_chk", "POST", {"user_id": uid, "daily_id": daily_id})
        except CheckInError as error:
            if error.refused:
                raise CheckInError(f"签到被拒绝，签到未完成：{error_detail(error)}", True) from error
            raise CheckInError(f"签到结果未确认：{error_detail(error)}。请求可能已生效，请稍后再次签到确认。") from error
        except Exception as error:
            # A lost answer does not mean JM rejected the write; never repeat this POST right away.
            raise CheckInError(f"签到结果未确认：{error_detail(error)}。请求可能已生效，请稍后再次签到确认。") from error
        return self._classify(envelope, result, relogged)

    @staticmethod
    def _assert_envelope(envelope: object) -> None:
        if not isinstance(envelope, dict) or envelope.get("code") is None:
            return
        try:
            code = int(envelope["code"])
        except (TypeError, ValueError):
            code = 0
        if code != 200:
            raise CheckInError(f"签到接口状态 {envelope['code']}：{message_of(envelope) or '接口未提供原因'}", code in (403, 429))

    @staticmethod
    def _classify(envelope: object, result: object, relogged: bool) -> dict | None:
        messages = []
        for item in (message_of(result), message_of(envelope)):
            if item and item not in messages:
                messages.append(item)
        message = "；".join(messages)
        status = str(result.get("status") if isinstance(result, dict) and result.get("status") is not None else "").strip().lower()
        success_status = status in {"success", "ok", "1", "true", "200"}
        failed_status = status in {"fail", "failed", "failure", "error", "0", "false"} or bool(re.fullmatch(r"[45]\d\d", status))

        def bad_code(container: object) -> bool:
            if not isinstance(container, dict) or container.get("code") is None:
                return False
            try:
                return int(container["code"]) != 200
            except (TypeError, ValueError):
                return True

        failed_message = bool(FAILED_MESSAGE.search(message))
        if ALREADY_MESSAGE.search(message) and not failed_message:
            return {"status": "already", "message": f"今天已签到，无需重复提交{f'：{message}' if message else ''}"}
        error_text = message_of(result.get("error")) if isinstance(result, dict) else ""
        error_text = error_text or (message_of(envelope.get("error")) if isinstance(envelope, dict) else "")
        if failed_status or bad_code(envelope) or bad_code(result) or failed_message or error_text:
            code = (result.get("code") if isinstance(result, dict) else None) or (envelope.get("code") if isinstance(envelope, dict) else None)
            raise CheckInError(f"签到接口返回失败：{message or f'状态 {status or code}'}")
        if is_empty(result) and not message and not status:
            if not relogged:
                return None
            raise CheckInError("签到接口返回了空结果，未确认成功：已重新登录但仍没有签到结果。请稍后再次签到确认。")
        # The real success answer carries only rewards, e.g. {"msg":"Jcoin:10 EXP:10"}.
        rewards = [reward_text(kind, amount) for kind, amount in REWARD_PATTERN.findall(message)]
        if (not success_status and not SUCCESS_MESSAGE.search(message) and not rewards) or (status and not success_status):
            raise CheckInError(f"签到响应异常，未确认成功{f'：{message}' if message else ''}{f'（状态 {status}）' if status else ''}。请稍后再次签到确认。")
        if rewards and not re.sub(r"[\s,，、；;]+", "", REWARD_PATTERN.sub("", message)):
            return {"status": "success", "message": f"签到成功：获得 {'、'.join(rewards)}"}
        localized = REWARD_PATTERN.sub(lambda match: f"获得 {reward_text(match.group(1), match.group(2))}", message)
        return {"status": "success", "message": localized or "签到成功"}
