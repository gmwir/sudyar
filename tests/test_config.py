import pytest

from sudyar import __main__ as cli
from sudyar.config import Settings


def test_missing_token_is_reported_clearly():
    s = Settings(postgres_password="x", variants_path="/v")
    assert any("DIGIKALA_SELF_TOKEN is missing" in p for p in s.problems())


def test_check_config_fails_without_token(monkeypatch, capsys, tmp_path):
    monkeypatch.chdir(tmp_path)  # no .env here
    for k in ("DIGIKALA_SELF_TOKEN", "POSTGRES_PASSWORD", "DATABASE_URL", "DIGIKALA_VARIANTS_PATH"):
        monkeypatch.delenv(k, raising=False)
    assert cli.main(["check-config"]) == 1
    assert "DIGIKALA_SELF_TOKEN is missing" in capsys.readouterr().out


def test_check_config_ok_does_not_print_secrets(monkeypatch, capsys, tmp_path):
    monkeypatch.chdir(tmp_path)
    monkeypatch.setenv("DIGIKALA_SELF_TOKEN", "tok-very-secret")
    monkeypatch.setenv("POSTGRES_PASSWORD", "pw-very-secret")
    monkeypatch.setenv("DIGIKALA_VARIANTS_PATH", "/v")
    assert cli.main(["check-config"]) == 0
    out = capsys.readouterr().out
    assert "tok-very-secret" not in out and "pw-very-secret" not in out
