import type { AskEscalator } from "#src/authority/authorizer-selection";
import { resolutionFor } from "#src/authority/decision-resolution";
import type { DecisionSource } from "#src/authority/decision-source";
import type { PermissionPromptDecision } from "#src/authority/permission-dialog";
import type { DecisionReporter } from "#src/logging/decision-reporter";
import { createPermissionRequestId } from "#src/permission-request-id";
import { applyPermissionGate } from "#src/policy/permission-gate";
import type { ScopedPermissionResolver } from "#src/policy/permission-resolver";
import {
  renderPolicyDenial,
  renderRefusal,
} from "#src/presentation/agent-renderer";
import { renderReviewLogFacts } from "#src/presentation/review-log-renderer";
import type { SessionApprovalRecorder } from "#src/session/session-approval-recorder";
import type {
  DecisionEventFacts,
  GateDescriptor,
  GateResult,
} from "./descriptor";
import {
  isGateBypass,
  isGateDescriptor,
  orderDenyFirst,
  preResolvedCheckOf,
} from "./descriptor";
import { buildDecisionEvent, resolveYoloGrant } from "./helpers";
import type { GateOutcome } from "./types";

// ── GateRunner class ───────────────────────────────────────────────────────

/**
 * Executes permission gates with their individual logs, decisions and grants.
 *
 * Constructed once per handler with its four role collaborators and reused
 * for every tool-call pipeline. `runAll` presents all asking gates together,
 * preserving nested path requirements; `run` supports independent skill gates
 * and the same null / bypass / descriptor dispatch.
 */
export class GateRunner {
  constructor(
    private readonly resolver: ScopedPermissionResolver,
    private readonly recorder: SessionApprovalRecorder,
    private readonly prompter: AskEscalator,
    private readonly reporter: DecisionReporter,
    /**
     * Live yolo reader, read per gate so a mid-session config change takes
     * effect — the same closure `PermissionManager` receives.
     */
    private readonly isYoloEnabled: () => boolean,
  ) {}

  /** Resolve the entire call before asking, then disclose every asking gate. */
  async runAll(
    gates: GateResult[],
    agentName: string | null,
  ): Promise<GateOutcome> {
    const resolved: GateResult[] = gates.map((gate) =>
      isGateDescriptor(gate)
        ? {
            ...gate,
            preCheck:
              preResolvedCheckOf(gate) ??
              this.resolver.resolve({
                kind: "tool",
                surface: gate.surface,
                input: gate.input,
                agentName: agentName ?? undefined,
              }),
          }
        : gate,
    );
    const ordered = orderDenyFirst(resolved);
    const asking = resolved.filter(
      (gate): gate is GateDescriptor =>
        isGateDescriptor(gate) &&
        gate.preCheck?.state === "ask" &&
        !this.isYoloEnabled(),
    );
    let decision: Promise<PermissionPromptDecision> | undefined;
    const escalator: AskEscalator =
      asking.length < 2
        ? this.prompter
        : {
            escalate: (details) => {
              decision ??= this.prompter.escalate({
                ...details,
                surface: null,
                accessIntent: undefined,
                requirements: asking.flatMap(
                  (gate) =>
                    gate.promptDetails.requirements ?? [
                      gate.promptDetails.accessIntent,
                    ],
                ),
                payload: {
                  ...details.payload,
                  requirements: asking.flatMap(
                    (gate) => gate.payload.requirements ?? [gate.payload],
                  ),
                },
                sessionLabel: "Yes, all listed permissions for this session",
                sessionApproval: {
                  grants: asking.flatMap(
                    (gate) => gate.sessionApproval?.grants ?? [],
                  ),
                },
              });
              return decision;
            },
          };
    for (const gate of ordered) {
      const outcome = isGateDescriptor(gate)
        ? await this.runDescriptor(
            gate,
            agentName,
            createPermissionRequestId(),
            escalator,
          )
        : await this.run(gate, agentName);
      if (outcome.action === "block") return outcome;
    }
    return { action: "allow" };
  }

  /**
   * Execute a gate: null → allow; bypass → log/emit side effects then allow;
   * descriptor → full check→log→emit→approve cycle.
   *
   * The request id is minted here, before the branch, so a request that never
   * prompts is identified exactly as one that does.
   */
  async run(gate: GateResult, agentName: string | null): Promise<GateOutcome> {
    if (!gate) {
      return { action: "allow" };
    }
    const requestId = createPermissionRequestId();
    if (isGateBypass(gate)) {
      if (gate.log) {
        this.reporter.writeReviewLog(gate.log.event, {
          ...gate.log.details,
          requestId,
          decidedBy: gate.decidedBy,
        });
      }
      if (gate.decision) {
        this.emitDecision(requestId, gate.decision);
      }
      return { action: "allow" };
    }
    return this.runDescriptor(gate, agentName, requestId);
  }

  // ── Private helpers ──────────────────────────────────────────────────────

  /**
   * The one place a decision event acquires its request id, so no emit path
   * can be added that forgets it.
   */
  private emitDecision(requestId: string, facts: DecisionEventFacts): void {
    this.reporter.emitDecision({ requestId, ...facts });
  }

  private async runDescriptor(
    descriptor: GateDescriptor,
    agentName: string | null,
    requestId: string,
    escalator: AskEscalator = this.prompter,
  ): Promise<GateOutcome> {
    // 1. Resolve permission state — what the descriptor already carries, or
    // via the resolver when it carries nothing.
    const check =
      preResolvedCheckOf(descriptor) ??
      this.resolver.resolve({
        kind: "tool",
        surface: descriptor.surface,
        input: descriptor.input,
        agentName: agentName ?? undefined,
      });

    // The fields every review-log write for this gate shares, whatever the
    // resolution — built once so a field added here reaches all of them. The
    // payload's request facts are stamped here rather than by each gate, for
    // the same reason `requestId` is: a gate cannot forget what it never
    // supplies (ADR 0011 §6).
    const logContext = {
      ...descriptor.logContext,
      ...renderReviewLogFacts(descriptor.payload),
      agentName,
      requestId,
    };

    // Each resolution below states its own decider. The provenance is built
    // at the branch that decides rather than merged into `logContext`: that
    // context holds what every resolution of this gate shares, and who decided
    // is by definition not shared (#726).

    // 2. Session-hit fast path: a session grant is an allow. `SessionRules`
    // records nothing else, so a session-sourced ask or deny means something
    // clamped a grant, and it takes the gate below instead of riding the grant.
    if (check.source === "session" && check.state === "allow") {
      this.reporter.writeReviewLog("permission_request.session_approved", {
        ...logContext,
        resolution: "session_approved",
        sessionApprovalPattern: check.matchedPattern,
        decidedBy: {
          kind: "session_approval",
          surface: descriptor.surface,
          pattern: check.matchedPattern ?? null,
        },
      });
      this.emitDecision(
        requestId,
        buildDecisionEvent(
          descriptor.decision,
          check,
          agentName,
          "allow",
          "session_approved",
        ),
      );
      return { action: "allow" };
    }

    // 2b. Yolo fast-path — the composition-stage ask→allow rewrite (origin
    // "yolo" on the matched rule, #526) or, under yolo, an ask synthesized
    // after resolution (#712). Auto-approve without prompting, preserving the
    // single auto_approved review entry + decision event so log parity holds.
    const yoloGrant = resolveYoloGrant(check, this.isYoloEnabled());
    if (yoloGrant) {
      // The pattern that raised the ask, sentinel included: "yolo allowed it"
      // alone does not say why it was asked in the first place. One record for
      // both the review entry and the broadcast, so they cannot disagree.
      const decidedByYolo: DecisionSource = {
        kind: "yolo",
        pattern: check.matchedPattern ?? null,
      };
      this.reporter.writeReviewLog("permission_request.auto_approved", {
        ...logContext,
        resolution: "auto_approved",
        decidedBy: decidedByYolo,
      });
      this.emitDecision(
        requestId,
        buildDecisionEvent(
          descriptor.decision,
          yoloGrant,
          agentName,
          "allow",
          resolutionFor(decidedByYolo, { approved: true, forSession: false }),
        ),
      );
      return { action: "allow" };
    }

    // 3. Apply the deny/ask/allow gate — always escalate on ask; the selected
    // Authorizer answers (the DenyingAuthorizer by denying with a marker).

    // The agent-facing renders of this ask. The rule reason is the operator's
    // deny-with-reason text, which lives on the resolved check rather than the
    // payload: no human render wants it, because a deny never prompts.
    const { payload } = descriptor;
    const messages = {
      denyReason: renderPolicyDenial(payload, check.reason ?? null),
      refusedReason: (decision: PermissionPromptDecision) =>
        renderRefusal(
          payload,
          decision.decidedBy,
          decision.denialReason ?? null,
        ),
    };

    // The rule that resolved this gate, and the decider for every arm that
    // never escalates: `allow` and `deny` are recorded authority answering.
    const decidedByRule: DecisionSource = {
      kind: "rule",
      surface: descriptor.surface,
      pattern: check.matchedPattern ?? null,
      origin: check.origin,
    };
    const gateResult = await applyPermissionGate({
      state: check.state,
      canGrantForSession: descriptor.sessionApproval?.isRecordable ?? false,
      promptForApproval: async () => {
        const decision = await escalator.escalate({
          requestId,
          payload,
          ...descriptor.promptDetails,
          ...(descriptor.sessionApproval
            ? { sessionApproval: descriptor.sessionApproval.toForwardedData() }
            : {}),
        });
        return decision;
      },
      writeLog: (event, details) =>
        this.reporter.writeReviewLog(event, details),
      logContext,
      decidedByRule,
      messages,
    });

    // 4. Determine whether session approval was granted, and at what width
    const sessionGrant =
      gateResult.action === "allow" ? gateResult.sessionGrant : undefined;

    // 5. Emit decision event
    this.emitDecision(
      requestId,
      buildDecisionEvent(
        descriptor.decision,
        check,
        agentName,
        gateResult.action === "allow" ? "allow" : "deny",
        resolutionFor(gateResult.decidedBy, {
          approved: gateResult.action === "allow",
          forSession: sessionGrant !== undefined,
        }),
      ),
    );

    // 6. Record session approval — tell the store; it owns the per-pattern loop
    // A present grant already implies gateResult.action === "allow".
    if (sessionGrant && descriptor.sessionApproval) {
      this.recorder.recordSessionApproval(
        descriptor.sessionApproval.atWidth(sessionGrant.width),
      );
    }

    if (gateResult.action === "block") {
      return { action: "block", reason: gateResult.reason };
    }

    return { action: "allow" };
  }
}
