"""The inventory/accounting module (existing Amiran Yadak app) is served under /anbar/ behind the same login."""
import pytest

from test_web_auth import login
from webfx import PASSWORD, client, make_app, make_factory


@pytest.fixture
def protected():
    return client(make_app(make_factory(), web_password=PASSWORD))


@pytest.fixture
def open_app():
    return client(make_app(make_factory()))


def test_requires_login(protected):
    for path in ("/anbar", "/anbar/", "/anbar/index.html", "/anbar/core.js"):
        r = protected.get(path, follow_redirects=False)
        assert r.status_code in (303, 401), path


def test_served_after_login_with_its_own_csp(protected):
    assert login(protected).status_code == 303
    r = protected.get("/anbar/")
    assert r.status_code == 200 and "انبار امیران یدک" in r.text
    csp = r.headers["content-security-policy"]
    assert "https://api.anthropic.com" in csp and "script-src 'self'" in csp and "'unsafe-eval'" not in csp
    assert protected.get("/anbar/core.js").status_code == 200
    assert protected.get("/anbar/manifest.webmanifest").status_code == 200
    assert protected.get("/anbar/sw.js").status_code == 200


def test_rest_of_site_keeps_strict_csp(open_app):
    assert "api.anthropic.com" not in open_app.get("/").headers["content-security-policy"]


@pytest.mark.parametrize("path", ["/anbar/../app.py", "/anbar/%2e%2e/app.py", "/anbar/..%2fapp.py", "/anbar/nope.js", "/anbar/sub/"])
def test_no_traversal_or_missing_files(open_app, path):
    assert open_app.get(path).status_code == 404


def test_settings_links_to_module(open_app):
    assert 'href="/anbar/"' in open_app.get("/settings").text
