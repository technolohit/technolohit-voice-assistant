import re


NO_PHONE = "No phone captured"
PHONE_LIKE_RE = re.compile(r"(?<![\w])(?:\+?\d[\d\s()./-]{5,}\d)(?![\w])")


def normalize_phone_display(phone: str | None) -> str:
    return re.sub(r"\s+", " ", str(phone or "").strip())


def mask_phone(phone: str | None) -> str:
    text = normalize_phone_display(phone)
    if not text:
        return NO_PHONE

    prefix = "+" if text.startswith("+") else ""
    digits = re.sub(r"\D", "", text)
    if len(digits) <= 7:
        return f"{prefix}{digits[:2]} ****" if digits else NO_PHONE

    first_len = 3 if prefix else 4
    first = digits[:first_len]
    last = digits[-3:]
    return f"{prefix}{first} **** {last}"


def bounded_text(value: str | None, limit: int = 1200) -> str:
    text = re.sub(r"\s+", " ", str(value or "").strip())
    if len(text) <= limit:
        return text
    return text[: limit - 3].rstrip() + "..."


def redact_phone_like(value: str | None) -> str:
    def replace(match: re.Match) -> str:
        digits = re.sub(r"\D", "", match.group(0))
        if len(digits) >= 7:
            return "[phone redacted]"
        return match.group(0)

    return PHONE_LIKE_RE.sub(replace, str(value or ""))
