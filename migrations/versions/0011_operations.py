"""Part 6 operations: write_log, pricing bot, FX, inventory, stock pools, finance, SBS, promotions

Revision ID: 0011
Revises: 0010
"""
import sqlalchemy as sa
from alembic import op

revision = "0011"
down_revision = "0010"
branch_labels = None
depends_on = None

TABLES = ("write_log", "reprice_rules", "reprice_actions", "fx_rates", "inventory_items", "stock_pools",
          "stock_pool_members", "invoices", "payouts", "sbs_shipments", "promotions")


def upgrade() -> None:
    op.create_table(
        "write_log",
        sa.Column("id", sa.Integer(), primary_key=True, autoincrement=True),
        sa.Column("ts", sa.DateTime(timezone=True), nullable=False),
        sa.Column("op", sa.String(64), nullable=False),
        sa.Column("target", sa.String(200)),
        sa.Column("mode", sa.String(16), nullable=False),
        sa.Column("payload", sa.JSON()),
        sa.Column("http_status", sa.Integer()),
        sa.Column("ok", sa.Boolean(), nullable=False),
        sa.Column("error", sa.String(300)),
        sa.Column("source", sa.String(32)),
    )
    op.create_index("ix_write_log_ts", "write_log", ["ts"])
    op.create_index("ix_write_log_op", "write_log", ["op"])
    op.create_table(
        "reprice_rules",
        sa.Column("variant_id", sa.Integer(), sa.ForeignKey("variants.id"), primary_key=True),
        sa.Column("enabled", sa.Boolean(), nullable=False),
        sa.Column("strategy", sa.String(16), nullable=False),
        sa.Column("gap_toman", sa.BigInteger()),
        sa.Column("gap_pct", sa.Float()),
        sa.Column("target_rank", sa.Integer()),
        sa.Column("max_toman", sa.BigInteger()),
        sa.Column("raise_when_alone", sa.Boolean(), nullable=False),
        sa.Column("raise_step_pct", sa.Float()),
        sa.Column("fx_currency", sa.String(8)),
        sa.Column("fx_base_amount", sa.Float()),
        sa.Column("fx_markup_pct", sa.Float()),
        sa.Column("updated_at", sa.DateTime(timezone=True), nullable=False),
    )
    op.create_table(
        "reprice_actions",
        sa.Column("id", sa.Integer(), primary_key=True, autoincrement=True),
        sa.Column("variant_id", sa.Integer(), sa.ForeignKey("variants.id"), nullable=False),
        sa.Column("ts", sa.DateTime(timezone=True), nullable=False),
        sa.Column("old_price", sa.BigInteger()),
        sa.Column("new_price", sa.BigInteger()),
        sa.Column("reason", sa.String(200), nullable=False),
        sa.Column("mode", sa.String(16), nullable=False),
        sa.Column("applied", sa.Boolean(), nullable=False),
    )
    op.create_index("ix_reprice_actions_variant_id", "reprice_actions", ["variant_id"])
    op.create_index("ix_reprice_actions_ts", "reprice_actions", ["ts"])
    op.create_table(
        "fx_rates",
        sa.Column("currency", sa.String(8), primary_key=True),
        sa.Column("toman_per_unit", sa.Float(), nullable=False),
        sa.Column("updated_at", sa.DateTime(timezone=True), nullable=False),
    )
    op.create_table(
        "inventory_items",
        sa.Column("product_variant_id", sa.String(64), primary_key=True),
        sa.Column("supplier_code", sa.String(200)),
        sa.Column("title", sa.String(1000)),
        sa.Column("seller_stock", sa.Integer()),
        sa.Column("warehouse_stock", sa.Integer()),
        sa.Column("available", sa.Integer()),
        sa.Column("reserve", sa.Integer()),
        sa.Column("has_dead_stock", sa.Boolean()),
        sa.Column("fetched_at", sa.DateTime(timezone=True), nullable=False),
    )
    op.create_table(
        "stock_pools",
        sa.Column("id", sa.Integer(), primary_key=True, autoincrement=True),
        sa.Column("name", sa.String(200), unique=True, nullable=False),
        sa.Column("physical_qty", sa.Integer(), nullable=False),
        sa.Column("updated_at", sa.DateTime(timezone=True), nullable=False),
    )
    op.create_table(
        "stock_pool_members",
        sa.Column("pool_id", sa.Integer(), sa.ForeignKey("stock_pools.id"), primary_key=True),
        sa.Column("variant_id", sa.Integer(), sa.ForeignKey("variants.id"), primary_key=True, unique=True),
        sa.Column("weight", sa.Integer(), nullable=False),
    )
    op.create_table(
        "invoices",
        sa.Column("id", sa.BigInteger(), primary_key=True),
        sa.Column("start_date", sa.String(40)),
        sa.Column("end_date", sa.String(40)),
        sa.Column("cash_sale_date", sa.String(40)),
        sa.Column("credit_sale_date", sa.String(40)),
        sa.Column("total_amount", sa.BigInteger()),
        sa.Column("payout_status", sa.String(40)),
        sa.Column("settlement_status", sa.String(40)),
        sa.Column("fetched_at", sa.DateTime(timezone=True), nullable=False),
    )
    op.create_table(
        "payouts",
        sa.Column("id", sa.BigInteger(), primary_key=True),
        sa.Column("amount", sa.BigInteger()),
        sa.Column("status", sa.String(40)),
        sa.Column("tracking_code", sa.String(100)),
        sa.Column("payout_date", sa.String(40)),
        sa.Column("fetched_at", sa.DateTime(timezone=True), nullable=False),
    )
    op.create_table(
        "sbs_shipments",
        sa.Column("shipment_id", sa.BigInteger(), primary_key=True),
        sa.Column("order_id", sa.BigInteger()),
        sa.Column("status", sa.String(64)),
        sa.Column("status_fa", sa.String(200)),
        sa.Column("next_status", sa.String(40)),
        sa.Column("promise_date", sa.String(40)),
        sa.Column("order_date", sa.String(40)),
        sa.Column("shipping_provider", sa.String(40)),
        sa.Column("tracking_code", sa.String(100)),
        sa.Column("tracking_code_status", sa.String(20)),
        sa.Column("item_count", sa.Integer()),
        sa.Column("is_cancelled", sa.Boolean()),
        sa.Column("items", sa.JSON()),
        sa.Column("fetched_at", sa.DateTime(timezone=True), nullable=False),
    )
    op.create_index("ix_sbs_shipments_order_id", "sbs_shipments", ["order_id"])
    op.create_table(
        "promotions",
        sa.Column("id", sa.BigInteger(), primary_key=True),
        sa.Column("title", sa.String(300)),
        sa.Column("nature", sa.String(64)),
        sa.Column("status", sa.String(40)),
        sa.Column("start_at", sa.String(40)),
        sa.Column("end_at", sa.String(40)),
        sa.Column("fetched_at", sa.DateTime(timezone=True), nullable=False),
    )


def downgrade() -> None:
    for t in reversed(TABLES):
        op.drop_table(t)
