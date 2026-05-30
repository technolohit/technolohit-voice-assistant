from app.privacy import NO_PHONE, mask_phone, redact_phone_like


def test_mask_phone_examples():
    assert mask_phone("01764444444") == "0176 **** 444"
    assert mask_phone("+4917612345678") == "+491 **** 678"


def test_mask_phone_missing():
    assert mask_phone("") == NO_PHONE
    assert mask_phone(None) == NO_PHONE


def test_redact_phone_like_text():
    text = "Bitte rufen Sie mich unter +49 176 12345678 zurueck."
    assert "+49 176 12345678" not in redact_phone_like(text)
    assert "[phone redacted]" in redact_phone_like(text)
