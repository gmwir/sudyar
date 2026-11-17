"""variants and api_call_log

Revision ID: 0001
Revises:
"""
import sqlalchemy as sa
from alembic import op

revision = "0001"
down_revision = None
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.create_table(
        "variants",
        sa.Column("id", sa.Integer, primary_key=True, autoincrement=True),
        sa.Column("digikala_variant_id", sa.String(64), nullable=False),
        sa.Column("product_id", sa.String(64)),
        sa.Column("title", sa.String(1000)),
        sa.Column("our_price", sa.BigInteger),
        sa.Column("stock", sa.Integer),
        sa.Column("active", sa.Boolean, nullable=False, server_default=sa.true()),
        sa.Column("last_seen_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("raw_json", sa.JSON, nullable=False),
    )
    op.create_index("ix_variants_digikala_variant_id", "variants", ["digikala_variant_id"], unique=True)
    op.create_index("ix_variants_product_id", "variants", ["product_id"])
    op.create_table(
        "api_call_log",
        sa.Column("id", sa.Integer, primary_key=True, autoincrement=True),
        sa.Column("called_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("endpoint", sa.String(500), nullable=False),
        sa.Column("status", sa.Integer),
        sa.Column("duration_ms", sa.Integer),
    )


def downgrade() -> None:
    op.drop_table("api_call_log")
    op.drop_table("variants")
