"""profit floor: variant_costs, floor_settings, floor_events, fee_cache

Revision ID: 0004
Revises: 0003
"""
import sqlalchemy as sa
from alembic import op

revision = "0004"
down_revision = "0003"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.create_table(
        "variant_costs",
        sa.Column("variant_id", sa.Integer, sa.ForeignKey("variants.id"), primary_key=True),
        sa.Column("buy_cost", sa.BigInteger),
        sa.Column("source", sa.String(16), nullable=False),
        sa.Column("updated_at", sa.DateTime(timezone=True), nullable=False),
        sa.CheckConstraint("source in ('manual','excel')", name="ck_variant_costs_source"),
    )
    op.create_table(
        "floor_settings",
        sa.Column("id", sa.Integer, primary_key=True, autoincrement=True),
        sa.Column("scope", sa.String(16), nullable=False),
        sa.Column("scope_key", sa.String(200), nullable=False, server_default=""),
        sa.Column("margin_pct", sa.Float),
        sa.Column("min_profit_toman", sa.BigInteger),
        sa.Column("floor_manual_toman", sa.BigInteger),
        sa.Column("floor_manual_pct", sa.Float),
        sa.UniqueConstraint("scope", "scope_key", name="uq_floor_settings_scope"),
        sa.CheckConstraint("scope in ('global','brand','category','variant')", name="ck_floor_settings_scope"),
    )
    op.create_table(
        "floor_events",
        sa.Column("id", sa.Integer, primary_key=True, autoincrement=True),
        sa.Column("variant_id", sa.Integer, sa.ForeignKey("variants.id"), nullable=False),
        sa.Column("floor", sa.BigInteger),
        sa.Column("suggested_floor", sa.BigInteger),
        sa.Column("reason", sa.String(200), nullable=False),
        sa.Column("ts", sa.DateTime(timezone=True), nullable=False),
    )
    op.create_index("ix_floor_events_variant_id", "floor_events", ["variant_id"])
    op.create_index("ix_floor_events_ts", "floor_events", ["ts"])
    op.create_table(
        "fee_cache",
        sa.Column("key", sa.String(100), primary_key=True),
        sa.Column("data", sa.JSON, nullable=False),
        sa.Column("fetched_at", sa.DateTime(timezone=True), nullable=False),
    )


def downgrade() -> None:
    op.drop_table("fee_cache")
    op.drop_table("floor_events")
    op.drop_table("floor_settings")
    op.drop_table("variant_costs")
