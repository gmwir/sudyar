"""real fee + sales wiring: commissions, variant_brands, product_sales, manual cost components

Revision ID: 0005
Revises: 0004
"""
import sqlalchemy as sa
from alembic import op

revision = "0005"
down_revision = "0004"
branch_labels = None
depends_on = None

COMPONENTS = ("fulfillment", "tax", "ad_share", "return_reserve", "packaging")


def upgrade() -> None:
    for c in COMPONENTS:
        op.add_column("floor_settings", sa.Column(f"{c}_pct", sa.Float, nullable=True))
        op.add_column("floor_settings", sa.Column(f"{c}_toman", sa.BigInteger, nullable=True))
    op.create_table(
        "commissions",
        sa.Column("id", sa.Integer, primary_key=True, autoincrement=True),
        sa.Column("main_category_id", sa.String(64)),
        sa.Column("category_id", sa.String(64)),
        sa.Column("brand_id", sa.String(64)),
        sa.Column("brand_title", sa.String(300)),
        sa.Column("commission", sa.Float),
        sa.Column("extra_commission", sa.Float),
        sa.Column("return_free_commission", sa.Float),
        sa.Column("current_lead_time", sa.Integer),
        sa.Column("fetched_at", sa.DateTime(timezone=True), nullable=False),
    )
    op.create_index("ix_commissions_category_id", "commissions", ["category_id"])
    op.create_table(
        "variant_brands",
        sa.Column("variant_id", sa.Integer, sa.ForeignKey("variants.id"), primary_key=True),
        sa.Column("brand_id", sa.String(64), nullable=False),
        sa.Column("updated_at", sa.DateTime(timezone=True), nullable=False),
    )
    op.create_table(
        "product_sales",
        sa.Column("product_id", sa.String(64), primary_key=True),
        sa.Column("range", sa.String(32), primary_key=True),
        sa.Column("net_item_sold", sa.Integer),
        sa.Column("net_sales_amount", sa.BigInteger),
        sa.Column("order_count", sa.Integer),
        sa.Column("visit_count", sa.Integer),
        sa.Column("conversion_rate", sa.Float),
        sa.Column("fetched_at", sa.DateTime(timezone=True), nullable=False),
    )


def downgrade() -> None:
    op.drop_table("product_sales")
    op.drop_table("variant_brands")
    op.drop_index("ix_commissions_category_id", table_name="commissions")
    op.drop_table("commissions")
    for c in COMPONENTS:
        op.drop_column("floor_settings", f"{c}_toman")
        op.drop_column("floor_settings", f"{c}_pct")
