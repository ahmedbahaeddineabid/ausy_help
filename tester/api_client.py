"""Small client for the Auzy AI API, used by the tester (app.py). It plays auzy-backend's part: service key for
messages and the end of a conversation, staff token for the staff views."""
from __future__ import annotations

import requests


class ApiError(Exception):
    def __init__(self, message: str, status: int | None = None):
        super().__init__(message)
        self.status = status


class Api:
    def __init__(self, url: str, service_key: str, staff_token: str, timeout: float = 180):
        self.url = url.rstrip("/")
        self.service_key = service_key
        self.staff_token = staff_token
        self.timeout = timeout

    def _call(self, method: str, path: str, token: str | None = None, body: dict | None = None, params: dict | None = None):
        headers = {"Authorization": f"Bearer {token}"} if token else {}
        try:
            res = requests.request(method, f"{self.url}{path}", headers=headers, json=body, params=params, timeout=self.timeout)
        except requests.RequestException as e:
            raise ApiError(f"Can't reach the API at {self.url} ({type(e).__name__})") from None
        try:
            data = res.json()
        except ValueError:
            data = None
        if not res.ok:
            detail = (data or {}).get("message") or (data or {}).get("error") or res.reason
            raise ApiError(f"HTTP {res.status_code}: {detail}", res.status_code)
        return data

    def health(self):
        return self._call("GET", "/v1/health")

    def welcome(self, language: str, name: str = ""):
        return self._call("GET", "/v1/welcome", self.service_key, params={"language": language, "name": name})

    def send(self, payload: dict):
        return self._call("POST", "/v1/messages", self.service_key, payload)

    def end(self, conversation_id: str):
        return self._call("POST", f"/v1/conversations/{conversation_id}/end", self.service_key or self.staff_token)

    def conversation(self, conversation_id: str):
        return self._call("GET", f"/v1/conversations/{conversation_id}", self.staff_token)

    def clear_escalation(self, conversation_id: str, cleared_by: str | None = None):
        return self._call("POST", f"/v1/conversations/{conversation_id}/clear-escalation", self.staff_token,
                          {"clearedBy": cleared_by} if cleared_by else {})

    def summaries(self, urgent: bool = False, limit: int = 50):
        return self._call("GET", "/v1/summaries", self.staff_token, params={"urgent": str(urgent).lower(), "limit": limit})

    def costs(self, days: int = 30):
        return self._call("GET", "/v1/costs", self.staff_token, params={"days": days})
