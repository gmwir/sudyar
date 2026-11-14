"""cost_audit: one line per buy-cost change

Revision ID: 0009
Revises: 0008
"""
import sqlalchemy as sa
from alembic import op

revision = "0009"
down_revision = "0008"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.create_table(
        "cost_audit",
        sa.Column("id", sa.Integer, primary_key=True, autoincrement=True),
        sa.Column("variant_id", sa.Integer, nullable=False),
        sa.Column("digikala_variant_id", sa.String(64), nullable=False),
        sa.Column("old_cost", sa.BigInteger),
        sa.Column("new_cost", sa.BigInteger),
        sa.Column("source", sa.String(16), nullable=False),
        sa.Column("changed_at", sa.DateTime(timezone=True), nullable=False),
    )
    op.create_index("ix_cost_audit_variant_id", "cost_audit", ["variant_id"])
    op.create_index("ix_cost_audit_changed_at", "cost_audit", ["changed_at"])


def downgrade() -> None:
    op.drop_table("cost_audit")
