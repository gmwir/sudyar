"""seller_connections: Service Hub OAuth tokens (encrypted)

Revision ID: 0010
Revises: 0009
"""
import sqlalchemy as sa
from alembic import op

revision = "0010"
down_revision = "0009"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.create_table(
        "seller_connections",
        sa.Column("id", sa.Integer, primary_key=True),
        sa.Column("scopes", sa.String(500)),
        sa.Column("access_token_enc", sa.String(8000), nullable=False),
        sa.Column("refresh_token_enc", sa.String(4000), nullable=False),
        sa.Column("access_expires_at", sa.DateTime(timezone=True)),
        sa.Column("refresh_expires_at", sa.DateTime(timezone=True)),
        sa.Column("connected_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("updated_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("last_error", sa.String(300)),
    )


def downgrade() -> None:
    op.drop_table("seller_connections")
