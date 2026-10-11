"""The rest of the demo workspace: an evaluation suite, a workflow, automations and a budget.

Everything runs on the offline scripted model (no network, no cost). Runs are queued: the
worker evaluates the suite and drives the workflow a few seconds after the stack starts.
"""

from __future__ import annotations

from decimal import Decimal
from typing import Any

from sqlalchemy.ext.asyncio import AsyncSession

from gouvra.core.authz import WorkspaceContext
from gouvra.modules.agents.models import Agent
from gouvra.modules.automations import service as automations
from gouvra.modules.automations.schemas import AutomationCreateIn
from gouvra.modules.budgets.service import set_budget
from gouvra.modules.evaluations import service as evaluations
from gouvra.modules.evaluations.schemas import CaseIn, RunCreateIn, SuiteCreateIn
from gouvra.modules.workflows import service as workflows
from gouvra.modules.workflows.graph import Graph
from gouvra.modules.workflows.schemas import WorkflowCreateIn, WorkflowRunCreateIn

# The scripted model answers "Echo: <input>": three cases pass, one shows a readable failure.
CASES: list[dict[str, Any]] = [
    {"name": "Greeting", "input": "hello", "expected": "Echo: hello"},
    {"name": "Thanks", "input": "thanks", "expected": "Echo: thanks"},
    {"name": "Refund request", "input": "I want a refund", "expected": "Echo: I want a refund"},
    {"name": "Order status", "input": "Where is my order?", "expected": "It ships tomorrow."},
]


def _routing_graph(agent_id: str) -> dict[str, Any]:
    return {
        "nodes": [
            {"id": "input", "type": "start", "label": "Ticket", "position": {"x": 0, "y": 0}},
            {
                "id": "answer",
                "type": "agent",
                "label": "Draft a reply",
                "agent_id": agent_id,
                "position": {"x": 0, "y": 124},
            },
            {
                "id": "check",
                "type": "condition",
                "label": "Urgent?",
                "value": "{{steps.answer.output}}",
                "operand": "urgent",
                "position": {"x": 0, "y": 248},
            },
            {
                "id": "escalate",
                "type": "transform",
                "label": "Escalate",
                "template": "Escalated to on-call: {{steps.answer.output}}",
                "position": {"x": -140, "y": 372},
            },
            {"id": "output", "type": "end", "label": "Reply", "position": {"x": 0, "y": 496}},
        ],
        "edges": [
            {"id": "a", "source": "input", "target": "answer"},
            {"id": "b", "source": "answer", "target": "check"},
            {"id": "c", "source": "check", "target": "escalate", "branch": "true"},
            {"id": "d", "source": "escalate", "target": "output"},
            {"id": "e", "source": "check", "target": "output", "branch": "false"},
        ],
    }


async def seed_extras(db: AsyncSession, ctx: WorkspaceContext, offline: Agent) -> int:
    """Create the extras; returns how many executions they queued (the suite's cases)."""
    suite = await evaluations.create_suite(
        db,
        ctx,
        SuiteCreateIn(
            name="Ticket replies",
            description="Does the offline agent answer the usual tickets as expected?",
            agent_id=offline.id,
            default_graders=[{"type": "exact"}],  # type: ignore[list-item]
        ),
    )
    await evaluations.add_cases(db, ctx, suite, [CaseIn.model_validate(c) for c in CASES])
    queued = 0
    for label, instructions in (("Baseline", None), ("Shorter instructions", "Be brief.")):
        await evaluations.start_run(
            db,
            ctx,
            suite,
            RunCreateIn(
                suite_id=suite.id, agent_id=offline.id, label=label, instructions=instructions
            ),
        )
        queued += len(CASES)

    workflow = await workflows.create_workflow(
        db,
        ctx,
        WorkflowCreateIn(
            name="Ticket routing",
            description="Drafts a reply, then escalates urgent tickets.",
            graph=Graph.model_validate(_routing_graph(str(offline.id))),
        ),
    )
    await workflows.publish(db, ctx, workflow, "First version")
    await workflows.start_run(
        db, ctx, workflow, WorkflowRunCreateIn(input="This is urgent: the export fails")
    )

    await automations.create(
        db,
        ctx,
        AutomationCreateIn(
            name="Morning digest",
            description="Every weekday, a summary of yesterday's tickets.",
            kind="schedule",
            target_type="agent",
            agent_id=offline.id,
            input="Summarise yesterday's tickets",
            cron="0 9 * * 1-5",
            timezone="Europe/Paris",
        ),
    )
    await automations.create(
        db,
        ctx,
        AutomationCreateIn(
            name="Ticket created",
            description="Routes each new ticket sent by the help desk.",
            kind="webhook",
            target_type="workflow",
            workflow_id=workflow.id,
            input_template="{{input.ticket.title}}",
        ),
    )
    await set_budget(db, ctx, monthly_limit=Decimal(25), thresholds=[50, 80, 100], hard_stop=False)
    await db.commit()
    return queued
