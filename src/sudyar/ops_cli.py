"""Part 6 commands (pricing bot, stock, finance, ship-by-seller, promotions, bulk). Called from __main__.

Every command that would change something on Digikala first prints what it will do and asks for YES, unless
--yes is given. With WRITE_MODE=off nothing is sent anyway; dry_run only records the write in write_log.
"""
from __future__ import annotations

import asyncio
import sys
from datetime import timedelta
from pathlib import Path

from .config import load_settings
from .logging_setup import short_error

OPS_USAGE = """Part 6 commands (WRITE_MODE in .env: off | dry_run | live; default off = nothing is sent):
  write-status                         mode + last 20 writes
  reprice-rule --variant ID [--strategy buybox|undercut|rank|fx|hold] [--gap-toman N] [--gap-pct P]
               [--rank N] [--max-toman N] [--raise yes|no] [--raise-step P] [--fx USD --fx-base A --fx-markup P]
               [--on|--off]
  reprice-rules                        list rules
  fx-rate CUR TOMAN                    e.g. fx-rate USD 92000
  reprice-once [--variant ID]          one pricing-bot cycle
  reprice-run                          pricing bot loop (every REPRICE_INTERVAL_SECONDS)
  smart-discount --variant ID --price-toman N --limit N --order-limit N --days D [--yes]
  inventory-sync | low-stock
  pool-set --name X --qty N --members ID:W,ID:W     pool-show | pool-push --name X [--yes]
  finance-sync | finance-show
  sbs-sync | sbs-show | sbs-status --ids 1,2 --to processing|processed [--yes]
  sbs-tracking FILE [--yes]            columns shipment_id, tracking_code
  sbs-labels --ids 1,2 [--sender TEXT] writes data/labels.html (customer data is not stored)
  promo-sync | promo-show | promo-join --promotion ID [--yes] | promo-auto [--yes]
  bulk-update FILE [--yes]             columns variant_id + price_toman/seller_stock/lead_time/maximum_per_order"""

OPS_COMMANDS = ("write-status", "reprice-rule", "reprice-rules", "fx-rate", "reprice-once", "reprice-run",
                "smart-discount", "inventory-sync", "low-stock", "pool-set", "pool-show", "pool-push", "finance-sync",
                "finance-show", "sbs-sync", "sbs-show", "sbs-status", "sbs-tracking", "sbs-labels", "promo-sync",
                "promo-show", "promo-join", "promo-auto", "bulk-update", "ops-help")


def _opt(args: list[str], name: str, cast=str, default=None):
    if name in args:
        i = args.index(name)
        if i + 1 >= len(args):
            raise ValueError(f"{name} needs a value")
        return cast(args[i + 1])
    return default


def _confirm(args: list[str], what: str, mode: str) -> bool:
    print(f"WRITE_MODE={mode}. " + {"off": "Nothing will be sent (WRITE_MODE=off).",
                                     "dry_run": "Dry-run: only recorded in write_log, nothing is sent.",
                                     "live": "LIVE: this WILL change your Digikala panel."}[mode])
    if "--yes" in args or mode == "off":
        return True
    try:
        return input(f"{what}\nType YES to continue: ").strip() == "YES"
    except EOFError:
        return False


class Ctx:
    def __init__(self, need_api: bool = True):
        from .__main__ import _build
        from .db import make_engine, make_session_factory
        from .rate_limiter import LimiterConfig, RateLimiter
        from .writer import DigikalaWriter

        self.s = load_settings()
        self.s.require_ok()
        if need_api:
            self.factory, self.client = _build(self.s)
            s = self.s
            limiter = RateLimiter(LimiterConfig(
                requests=s.rate_limit_requests, period_seconds=s.rate_limit_period_seconds,
                max_concurrent=1, max_retries=min(2, s.max_retries), backoff_base=s.backoff_base_seconds,
                backoff_max=s.backoff_max_seconds, breaker_threshold=s.breaker_threshold,
                breaker_pause=s.breaker_pause_seconds))
            provider = None
            if s.oauth_mode:
                from .__main__ import _oauth_token_provider
                provider = _oauth_token_provider(s, self.factory)
            self.writer = DigikalaWriter(s, limiter, self.factory, token_provider=provider)
        else:
            self.factory = make_session_factory(make_engine(self.s.database_url))
            self.client = self.writer = None

    def floor(self):
        from .fees import FeeProvider
        from .floor import FloorEngine
        return FloorEngine(self.s, FeeProvider(self.client, self.s))

    async def close(self):
        if self.client is not None:
            await self.client.aclose()
        if self.writer is not None:
            await self.writer.aclose()


def _data_dir() -> Path:
    return Path("/data") if Path("/data").is_dir() else Path("data")


def _in_file(name: str) -> Path:
    p = Path(name)
    if p.is_file():
        return p
    q = _data_dir() / p.name
    if q.is_file():
        return q
    raise FileNotFoundError(f"file not found: {p.name} (put it in the data folder)")


def _t(rial) -> str:
    return "-" if rial is None else f"{int(rial) // 10:,}"


def run(cmd: str, args: list[str]) -> int:
    try:
        return _safe(cmd, args)
    except Exception as e:
        print(f"Command failed: {short_error(e)}")
        return 1


def _safe(cmd: str, args: list[str]) -> int:
    try:
        return asyncio.run(_run(cmd, args))
    except (ValueError, FileNotFoundError) as e:
        print(f"Error: {e}")
        return 2
    except Exception as e:
        from .writer import WriteDisabled, WriteRefused
        if isinstance(e, WriteDisabled):
            print("WRITE_MODE=off: nothing was sent to Digikala. Set WRITE_MODE=dry_run (test) or live in .env.")
            return 0
        if isinstance(e, WriteRefused):
            print(f"Refused: {e}")
            return 2
        raise
    except KeyboardInterrupt:
        print("Stopped.")
        return 0


async def _run(cmd: str, args: list[str]) -> int:  # noqa: C901 - a flat command switch reads best here
    from sqlalchemy import select

    from .models import (FxRate, RepriceAction, RepriceRule, SbsShipment, StockPool, Variant, WriteLog, utcnow)

    if cmd == "ops-help":
        print(OPS_USAGE)
        return 0
    offline = cmd in ("write-status", "reprice-rule", "reprice-rules", "fx-rate", "low-stock", "pool-set",
                      "pool-show", "finance-show", "sbs-show", "promo-show")
    ctx = Ctx(need_api=not offline)
    try:
        with ctx.factory() as session:
            if cmd == "write-status":
                print(f"WRITE_MODE={ctx.s.write_mode}")
                for w in session.scalars(select(WriteLog).order_by(WriteLog.id.desc()).limit(20)):
                    print(f"{w.ts:%Y-%m-%d %H:%M} {w.mode:7} {w.op:24} {w.target or '':20} "
                          f"{'OK' if w.ok else 'FAIL'} {w.http_status or ''} {w.error or ''}")
                return 0
            if cmd == "reprice-rule":
                from .repricer import set_rule
                vals = dict(strategy=_opt(args, "--strategy"), gap_toman=_opt(args, "--gap-toman", int),
                            gap_pct=_opt(args, "--gap-pct", float), target_rank=_opt(args, "--rank", int),
                            max_toman=_opt(args, "--max-toman", int), raise_step_pct=_opt(args, "--raise-step", float),
                            fx_currency=_opt(args, "--fx"), fx_base_amount=_opt(args, "--fx-base", float),
                            fx_markup_pct=_opt(args, "--fx-markup", float))
                r = _opt(args, "--raise")
                if r is not None:
                    vals["raise_when_alone"] = r.lower() in ("yes", "1", "true", "on")
                if "--on" in args or "--off" in args:
                    vals["enabled"] = "--on" in args
                vid = _opt(args, "--variant")
                if not vid:
                    raise ValueError("--variant is required")
                row = set_rule(session, vid, **vals)
                print(f"Rule saved: variant {vid} strategy={row.strategy} enabled={row.enabled} "
                      f"ceiling={row.max_toman or '-'} Toman")
                return 0
            if cmd == "reprice-rules":
                for rule, v in session.execute(select(RepriceRule, Variant).join(Variant, Variant.id == RepriceRule.variant_id)):
                    print(f"{v.digikala_variant_id:>12} {'ON ' if rule.enabled else 'OFF'} {rule.strategy:8} "
                          f"price={_t(v.price_sale)} ceiling={rule.max_toman or '-'} {(v.title or '')[:40]}")
                return 0
            if cmd == "fx-rate":
                from .repricer import set_fx_rate
                pos = [a for a in args if not a.startswith("--")]
                if len(pos) != 2:
                    raise ValueError("usage: fx-rate CUR TOMAN")
                r = set_fx_rate(session, pos[0], float(pos[1].replace(",", "")))
                print(f"{r.currency} = {r.toman_per_unit:,.0f} Toman")
                return 0
            if cmd in ("reprice-once", "reprice-run"):
                from .repricer import Repricer
                bot = Repricer(ctx.client, ctx.writer, ctx.factory, ctx.s, ctx.floor())
                print(f"Pricing bot, WRITE_MODE={ctx.s.write_mode}")
                while True:
                    rep = await bot.run_once(only_variant=_opt(args, "--variant"))
                    print(f"[reprice] checked={rep.checked} changed={rep.changed} skipped={rep.skipped} "
                          f"errors={rep.errors}", flush=True)
                    with ctx.factory() as s2:
                        for a in s2.scalars(select(RepriceAction).order_by(RepriceAction.id.desc()).limit(rep.checked)):
                            print(f"   variant#{a.variant_id} {_t(a.old_price)} -> {_t(a.new_price)} : {a.reason}")
                    if cmd == "reprice-once":
                        return 0
                    await asyncio.sleep(ctx.s.reprice_interval_seconds)
            if cmd == "smart-discount":
                from .repricer import create_smart_discount
                vid = _opt(args, "--variant")
                v = session.scalar(select(Variant).where(Variant.digikala_variant_id == str(vid)))
                if v is None:
                    raise ValueError("variant not found")
                price, limit = _opt(args, "--price-toman", int), _opt(args, "--limit", int)
                olim, days = _opt(args, "--order-limit", int, 1), _opt(args, "--days", int, 1)
                if not price or not limit:
                    raise ValueError("--price-toman and --limit are required")
                if not _confirm(args, f"Smart discount {vid}: {price:,} Toman, {limit} items, {days} day(s)",
                                ctx.s.write_mode):
                    return 1
                now = utcnow()
                await create_smart_discount(ctx.writer, ctx.floor(), session, v, price, limit, olim, now,
                                            now + timedelta(days=days), now)
                print("Done (see write-status).")
                return 0
            if cmd == "inventory-sync":
                from .inventory import sync_inventory
                print(f"Inventory rows: {await sync_inventory(ctx.client, session)}")
                return 0
            if cmd == "low-stock":
                from .inventory import low_stock
                rows = low_stock(session, ctx.s)
                print(f"Low stock (<= {ctx.s.low_stock_threshold}): {len(rows)}")
                for r in rows:
                    print(f"  {r.product_variant_id:>12} available={r.available} seller={r.seller_stock} "
                          f"warehouse={r.warehouse_stock} {(r.title or '')[:50]}")
                return 0
            if cmd == "pool-set":
                from .inventory import set_pool
                members = []
                for part in (_opt(args, "--members") or "").split(","):
                    if part.strip():
                        dk, _, w = part.partition(":")
                        members.append((dk.strip(), int(w or 1)))
                p = set_pool(session, _opt(args, "--name") or "", _opt(args, "--qty", int, -1), members)
                print(f"Pool '{p.name}' saved: {p.physical_qty} items, {len(members)} codes")
                return 0
            if cmd == "pool-show":
                from .inventory import plan_pool
                for p in session.scalars(select(StockPool)):
                    plan = plan_pool(session, p)
                    print(f"{p.name}: {p.physical_qty} -> " + ", ".join(f"{d}={q}" for d, q in plan.lines))
                return 0
            if cmd == "pool-push":
                from .inventory import plan_pool, push_pool
                p = session.scalar(select(StockPool).where(StockPool.name == (_opt(args, "--name") or "")))
                if p is None:
                    raise ValueError("pool not found")
                plan = plan_pool(session, p)
                if not _confirm(args, "Set seller stock: " + ", ".join(f"{d}={q}" for d, q in plan.lines),
                                ctx.s.write_mode):
                    return 1
                await push_pool(ctx.writer, plan)
                print("Sent (see write-status).")
                return 0
            if cmd == "finance-sync":
                from .finance import sync_finance
                i, p = await sync_finance(ctx.client, session)
                print(f"Invoices: {i}, payouts: {p}")
                return 0
            if cmd == "finance-show":
                from .finance import money_summary
                m = money_summary(session)
                print(f"Invoices not paid yet: {_t(m['invoices_unpaid'])} Toman | paid: {_t(m['invoices_paid'])} Toman")
                print(f"Payouts done: {_t(m['payouts_done'])} Toman | pending: {_t(m['payouts_pending'])} Toman")
                return 0
            if cmd == "sbs-sync":
                from .sbs import sync_sbs
                print(f"Ship-by-seller shipments: {await sync_sbs(ctx.client, session)}")
                return 0
            if cmd == "sbs-show":
                from .sbs import open_shipments
                for sh in open_shipments(session):
                    print(f"{sh.shipment_id:>10} {sh.status_fa or sh.status or '':24} promise={sh.promise_date or '-'} "
                          f"tracking={sh.tracking_code or '-'} items={sh.item_count}")
                return 0
            if cmd == "sbs-status":
                from .sbs import set_status
                ids = [int(x) for x in (_opt(args, "--ids") or "").split(",") if x.strip()]
                to = _opt(args, "--to") or ""
                if not _confirm(args, f"Set {len(ids)} shipment(s) to {to}", ctx.s.write_mode):
                    return 1
                await set_status(ctx.writer, ids, to)
                print("Sent (see write-status).")
                return 0
            if cmd == "sbs-tracking":
                from .sbs import parse_tracking_file, send_tracking_codes
                files = [a for a in args if not a.startswith("--")]
                if len(files) != 1:
                    raise ValueError("usage: sbs-tracking FILE")
                path = _in_file(files[0])
                pairs, errs = parse_tracking_file(path.read_bytes(), path.name)
                for e in errs[:30]:
                    print("  " + e)
                if errs or not pairs:
                    print("Fix the file first (nothing sent).")
                    return 1
                if not _confirm(args, f"Send {len(pairs)} tracking code(s)", ctx.s.write_mode):
                    return 1
                ok, fails = await send_tracking_codes(ctx.writer, pairs)
                print(f"Sent: {ok}, failed: {len(fails)}")
                for f in fails[:30]:
                    print("  " + f)
                return 0
            if cmd == "sbs-labels":
                from .sbs import render_labels
                ids = [int(x) for x in (_opt(args, "--ids") or "").split(",") if x.strip()]
                pairs = []
                for i in ids:
                    sh = session.get(SbsShipment, i)
                    if sh is None:
                        print(f"  {i}: not found (run sbs-sync)")
                        continue
                    pairs.append((sh, await ctx.client.get_sbs_customer(i)))
                out = _data_dir() / "labels.html"
                out.parent.mkdir(exist_ok=True)
                out.write_text(render_labels(pairs, _opt(args, "--sender", str, "")), encoding="utf-8")
                print(f"Labels: {len(pairs)} -> {out} (open it and print; delete it after printing)")
                return 0
            if cmd == "promo-sync":
                from .promotions import sync_promotions
                print(f"Promotions: {await sync_promotions(ctx.client, session)}")
                return 0
            if cmd == "promo-show":
                from .models import Promotion
                for p in session.scalars(select(Promotion).order_by(Promotion.start_at)):
                    print(f"{p.id:>8} {p.nature or '':18} {p.status or '':10} {p.start_at or ''} -> {p.end_at or ''} {p.title or ''}")
                return 0
            if cmd in ("promo-join", "promo-auto"):
                from .promotions import apply_join, autojoin_candidates, plan_join
                ids = ([_opt(args, "--promotion", int)] if cmd == "promo-join"
                       else [p.id for p in autojoin_candidates(session, ctx.s)])
                if not ids or ids == [None]:
                    raise ValueError("no promotion (use --promotion ID, or run promo-sync)")
                for pid in ids:
                    plan = await plan_join(ctx.client, session, ctx.s, ctx.floor(), pid)
                    print(f"Promotion {pid}: join {len(plan.join)}, skip {len(plan.skipped)}")
                    for j in plan.join[:50]:
                        print(f"   + {j['variant_id']} at {_t(j['promotion_price'])} Toman")
                    for sk in plan.skipped[:20]:
                        print(f"   - {sk}")
                    if plan.join and _confirm(args, f"Join {len(plan.join)} variant(s) to promotion {pid}",
                                              ctx.s.write_mode):
                        await apply_join(ctx.writer, plan)
                return 0
            if cmd == "bulk-update":
                from .bulk import apply_bulk, plan_bulk, read_rows
                files = [a for a in args if not a.startswith("--")]
                if len(files) != 1:
                    raise ValueError("usage: bulk-update FILE")
                path = _in_file(files[0])
                if path.stat().st_size > 2_000_000:
                    raise ValueError("file is larger than 2 MB")
                plan = await plan_bulk(session, ctx.floor(), read_rows(path.read_bytes(), path.name))
                for e in plan.errors[:50]:
                    print("  " + e)
                print(f"Rows OK: {len(plan.items)}, rejected: {len(plan.errors)}")
                if not plan.items or not _confirm(args, f"Update {len(plan.items)} variant(s)", ctx.s.write_mode):
                    return 1
                await apply_bulk(ctx.writer, plan)
                print("Sent (see write-status).")
                return 0
    finally:
        await ctx.close()
    print(OPS_USAGE)
    return 2


if __name__ == "__main__":  # pragma: no cover
    sys.exit(run(sys.argv[1], sys.argv[2:]))
