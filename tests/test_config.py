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


def test_real_api_defaults():
    s = Settings()
    assert s.base_url == "https://seller.digikala.com"
    assert s.variants_path == "/open-api/v1/variants"
    assert s.auth_prefix == "Bearer " and s.items_key == "data.items"


def test_buybox_status_counts(monkeypatch, capsys, tmp_path):
    from sqlalchemy import create_engine
    from sqlalchemy.orm import sessionmaker

    from sudyar.models import Base, Variant

    db = tmp_path / "t.db"
    monkeypatch.chdir(tmp_path)
    monkeypatch.setenv("DATABASE_URL", f"sqlite:///{db}")
    monkeypatch.setenv("DIGIKALA_SELF_TOKEN", "tok")
    eng = create_engine(f"sqlite:///{db}")
    Base.metadata.create_all(eng)
    with sessionmaker(eng)() as s:
        for i, (win, ch, act) in enumerate([(True, False, True), (False, True, True), (False, False, True), (True, False, False)]):
            s.add(Variant(digikala_variant_id=str(i), is_seller_buy_box_winner=win,
                          is_in_buy_box_challenge=ch, active=act, raw_json={}))
        s.commit()
    assert cli.main(["buybox-status"]) == 0
    out = capsys.readouterr().out
    assert "total (active): 3" in out and "We win Buy Box:          1" in out
    assert "We lose Buy Box:         2" in out and "challenge:    1" in out


def test_winning_price_needs_argument(capsys):
    assert cli.main(["winning-price"]) == 2
