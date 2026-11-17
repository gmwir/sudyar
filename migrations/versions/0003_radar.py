"""radar: snapshot.active, radar_events, hot_overrides

Revision ID: 0003
Revises: 0002
"""
import sqlalchemy as sa
from alembic import op

revision = "0003"
down_revision = "0002"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column("variant_snapshots", sa.Column("active", sa.Boolean, nullable=True))
    op.create_table(
        "radar_events",
        sa.Column("id", sa.Integer, primary_key=True, autoincrement=True),
        sa.Column("variant_id", sa.Integer, sa.ForeignKey("variants.id"), nullable=False),
        sa.Column("type", sa.String(32), nullable=False),
        sa.Column("old_value", sa.String(200)),
        sa.Column("new_value", sa.String(200)),
        sa.Column("details", sa.JSON),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("dedupe_key", sa.String(200), nullable=False),
        sa.Column("notified_at", sa.DateTime(timezone=True)),
        sa.Column("notify_status", sa.String(32)),
        sa.UniqueConstraint("dedupe_key", name="uq_radar_events_dedupe_key"),
    )
    op.create_index("ix_radar_events_variant_id", "radar_events", ["variant_id"])
    op.create_index("ix_radar_events_type", "radar_events", ["type"])
    op.create_index("ix_radar_events_created_at", "radar_events", ["created_at"])
    op.create_table(
        "hot_overrides",
        sa.Column("variant_id", sa.Integer, sa.ForeignKey("variants.id"), primary_key=True),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("note", sa.String(500)),
    )


def downgrade() -> None:
    op.drop_table("hot_overrides")
    op.drop_table("radar_events")
    op.drop_column("variant_snapshots", "active")
