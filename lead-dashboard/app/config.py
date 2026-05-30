import os
from dataclasses import dataclass


def _read(name: str, default: str = "") -> str:
    return str(os.getenv(name, default)).strip()


@dataclass(frozen=True)
class Settings:
    app_name: str
    environment: str
    database_url: str
    dashboard_user: str
    password_hash: str
    plaintext_password: str
    app_base_url: str

    @property
    def has_auth_config(self) -> bool:
        return bool(self.dashboard_user and (self.password_hash or self.plaintext_password))


def get_settings() -> Settings:
    return Settings(
        app_name=_read("LEAD_DASHBOARD_APP_NAME", "technolohit-lead-dashboard"),
        environment=_read("LEAD_DASHBOARD_ENV", "production"),
        database_url=_read("LEAD_DASHBOARD_DATABASE_URL") or _read("DATABASE_URL"),
        dashboard_user=_read("LEAD_DASHBOARD_USER"),
        password_hash=_read("LEAD_DASHBOARD_PASSWORD_HASH"),
        plaintext_password=_read("LEAD_DASHBOARD_PASSWORD"),
        app_base_url=_read("LEAD_DASHBOARD_APP_BASE_URL", "http://10.20.0.1:8090"),
    )
