"""buy box fields on variants + variant_snapshots history table

Revision ID: 0002
Revises: 0001
"""
import sqlalchemy as sa
from alembic import op

revision = "0002"
down_revision = "0001"
branch_labels = None
depends_on = None

NEW_COLUMNS = [
    ("product_variant_id", sa.String(64)),
    ("product_title", sa.String(1000)),
    ("is_archived", sa.Boolean),
    ("price_sale", sa.BigInteger),
    ("cash_selling_price", sa.BigInteger),
    ("price_limit", sa.BigInteger),
    ("marketplace_seller_stock", sa.Integer),
    ("warehouse_stock", sa.Integer),
    ("buy_box_price", sa.BigInteger),
    ("is_buy_box_winner", sa.Boolean),
    ("is_seller_buy_box_winner", sa.Boolean),
    ("is_in_buy_box_challenge", sa.Boolean),
    ("is_sku_winner", sa.Boolean),
    ("rating", sa.Float),
    ("lead_time", sa.Integer),
]


def upgrade() -> None:
    for name, typ in NEW_COLUMNS:
        op.add_column("variants", sa.Column(name, typ, nullable=True))
    op.create_index("ix_variants_product_variant_id", "variants", ["product_variant_id"])
    op.create_table(
        "variant_snapshots",
        sa.Column("id", sa.Integer, primary_key=True, autoincrement=True),
        sa.Column("variant_id", sa.Integer, sa.ForeignKey("variants.id"), nullable=False),
        sa.Column("taken_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("price_sale", sa.BigInteger),
        sa.Column("buy_box_price", sa.BigInteger),
        sa.Column("is_seller_buy_box_winner", sa.Boolean),
        sa.Column("is_in_buy_box_challenge", sa.Boolean),
        sa.Column("stock", sa.Integer),
    )
    op.create_index("ix_variant_snapshots_variant_id", "variant_snapshots", ["variant_id"])
    op.create_index("ix_variant_snapshots_taken_at", "variant_snapshots", ["taken_at"])


def downgrade() -> None:
    op.drop_table("variant_snapshots")
    op.drop_index("ix_variants_product_variant_id", table_name="variants")
    for name, _ in NEW_COLUMNS:
        op.drop_column("variants", name)
