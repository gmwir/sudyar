"""variant_costs: buy_cost must be NULL or > 0

Revision ID: 0006
Revises: 0005
"""
from alembic import op

revision = "0006"
down_revision = "0005"
branch_labels = None
depends_on = None

NAME = "ck_variant_costs_buy_cost_positive"


def upgrade() -> None:
    # Existing rows that would violate the rule become "unknown cost" (NULL) instead of failing the migration.
    op.execute("UPDATE variant_costs SET buy_cost = NULL WHERE buy_cost IS NOT NULL AND buy_cost <= 0")
    with op.batch_alter_table("variant_costs") as batch:
        batch.create_check_constraint(NAME, "buy_cost IS NULL OR buy_cost > 0")


def downgrade() -> None:
    with op.batch_alter_table("variant_costs") as batch:
        batch.drop_constraint(NAME, type_="check")
