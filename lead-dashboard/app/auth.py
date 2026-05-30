import secrets
from fastapi import Depends, HTTPException, Request, status
from fastapi.security import HTTPBasic, HTTPBasicCredentials

try:
    import bcrypt
except ImportError:  # pragma: no cover
    bcrypt = None


security = HTTPBasic()


def _verify_bcrypt(password: str, password_hash: str) -> bool:
    if bcrypt is None:
        return False
    try:
        return bool(bcrypt.checkpw(password.encode("utf-8"), password_hash.encode("utf-8")))
    except ValueError:
        return False


def require_user(
    request: Request,
    credentials: HTTPBasicCredentials = Depends(security),
) -> str:
    settings = request.app.state.settings
    if not settings.has_auth_config:
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail="dashboard_auth_not_configured",
        )

    user_ok = secrets.compare_digest(credentials.username, settings.dashboard_user)
    password_ok = False
    if settings.password_hash:
        password_ok = _verify_bcrypt(credentials.password, settings.password_hash)
    elif settings.plaintext_password:
        password_ok = secrets.compare_digest(credentials.password, settings.plaintext_password)

    if not (user_ok and password_ok):
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="invalid_credentials",
            headers={"WWW-Authenticate": "Basic"},
        )

    return credentials.username
