"""Server deployment package (Part 5a): server-mode safety rules and the deploy files."""
import pathlib

import yaml

from sudyar import __main__ as m

ROOT = pathlib.Path(__file__).resolve().parent.parent
GOOD = {"WEB_PASSWORD": "a-strong-pass-12", "WEB_SECRET_KEY": "k" * 64,
        "WEB_HTTPS_ONLY_COOKIE": "1", "WEB_TRUSTED_PROXIES": "172.31.250.10"}


def _env(monkeypatch, **over):
    for k, v in {**GOOD, **over}.items():
        monkeypatch.setenv(k, v)
    monkeypatch.setenv("SUDYAR_SERVER", "1")
    monkeypatch.setattr("sudyar.web.app.create_app", lambda *a, **k: (_ for _ in ()).throw(AssertionError("started")))


def test_server_mode_refuses_weak_or_missing_settings(monkeypatch, capsys):
    for key, bad in (("WEB_PASSWORD", ""), ("WEB_PASSWORD", "short"), ("WEB_SECRET_KEY", "x"),
                     ("WEB_TRUSTED_PROXIES", " ")):
        _env(monkeypatch, **{key: bad})
        assert m.web_cmd([]) == 1, (key, bad)
        assert "server mode" in capsys.readouterr().out


def test_web_cmd_refuses_to_start_in_server_mode_without_password(monkeypatch, capsys):
    for k in GOOD:
        monkeypatch.delenv(k, raising=False)
    monkeypatch.setenv("SUDYAR_SERVER", "1")
    monkeypatch.setattr("sudyar.web.app.create_app", lambda *a, **k: (_ for _ in ()).throw(AssertionError("started")))
    assert m.web_cmd([]) == 1
    assert "server mode" in capsys.readouterr().out


def _server_compose():
    return yaml.safe_load((ROOT / "deploy" / "docker-compose.server.yml").read_text())


def test_server_compose_proxy_ip_matches_trusted_proxy_and_db_stays_private():
    c = _server_compose()
    caddy, web = c["services"]["caddy"], c["services"]["web"]
    ip = caddy["networks"]["edge"]["ipv4_address"]
    assert web["environment"]["WEB_TRUSTED_PROXIES"] == ip
    assert web["environment"]["SUDYAR_SERVER"] == "1" and web["environment"]["WEB_HTTPS_ONLY_COOKIE"] == "1"
    assert "edge" in web["networks"]
    assert "db" not in c["services"]  # db is not touched: stays on the private default network only
    assert caddy["cap_drop"] == ["ALL"] and caddy["read_only"] is True
    assert "env_file" not in caddy  # Caddy never sees the Digikala token or passwords
    assert set(caddy["environment"]) == {"SUDYAR_DOMAIN", "ACME_EMAIL"}


def test_backup_keeps_14_days_and_never_writes_partial_files():
    cmd = "\n".join(_server_compose()["services"]["backup"]["command"])
    assert "pg_dump -Fc" in cmd and "-mtime +14 -delete" in cmd and ".tmp" in cmd


def test_caddyfile_https_headers_and_proxy():
    t = (ROOT / "deploy" / "Caddyfile").read_text()
    for s in ("reverse_proxy web:8080", "Strict-Transport-Security", "admin off", "max_size 3MB", "-Server"):
        assert s in t


def test_install_script_is_safe():
    t = (ROOT / "deploy" / "install.sh").read_text()
    assert "set -euo pipefail" in t and "chmod 600 .env" in t
    assert 'read -r -s -p "Web page password' in t and 'read -r -s -p "Digikala Self Token' in t  # hidden input
    assert "echo \"$p1\"" not in t and "echo \"$tok\"" not in t
    assert "ufw --force enable" in t and "ufw allow OpenSSH" in t
