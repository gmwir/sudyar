"""daily_sales: real per-day, per-variant sales from the Order API (no personal data)

Revision ID: 0008
Revises: 0007
"""
import sqlalchemy as sa
from alembic import op

revision = "0008"
down_revision = "0007"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.create_table(
        "daily_sales",
        sa.Column("day", sa.Date, primary_key=True),
        sa.Column("product_variant_id", sa.String(64), primary_key=True),
        sa.Column("unit_sale_price", sa.BigInteger, primary_key=True),
        sa.Column("quantity", sa.Integer, nullable=False),
        sa.Column("synced_at", sa.DateTime(timezone=True), nullable=False),
    )
    op.create_index("ix_daily_sales_product_variant_id", "daily_sales", ["product_variant_id"])


def downgrade() -> None:
    op.drop_index("ix_daily_sales_product_variant_id", table_name="daily_sales")
    op.drop_table("daily_sales")
