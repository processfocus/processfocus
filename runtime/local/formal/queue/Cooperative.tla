---------------------------- MODULE Cooperative ----------------------------
EXTENDS Lifecycle

(* Cooperative refinement of the original extraction. Claim/priority, attempt
   budget, success and terminal retention reuse Lifecycle's actions. Execution
   includes dispatch, acknowledgement and finalization; hung covers any of them.
   Assumptions: the scheduler/clock and DB are available, queue I/O completes
   within its bound, and interrupted work/cleanup stops within GraceTicks.
   Non-cooperative cleanup goes to supervision, NOT this progress assumption.
   Ticks abstract bounded controller response, rather than assuming fair job
   selection. Lease loss is permitted even during otherwise legitimate work. *)

CONSTANTS ExecutionTicks, GraceTicks
ASSUME /\ ExecutionTicks \in Nat \ {0}
       /\ GraceTicks \in Nat \ {0}

VARIABLES deadline, cleanup, owned, occupation
cvars == <<vars, deadline, cleanup, owned, occupation>>

ExtraUnchanged == UNCHANGED <<deadline, cleanup, owned, occupation>>
CInit == Init /\ deadline = 0 /\ cleanup = 0 /\ owned = FALSE
              /\ occupation = 0
CSelect == Select /\ ExtraUnchanged
CClaim == Claim /\ deadline' = ExecutionTicks /\ cleanup' = 0
                /\ owned' = TRUE /\ occupation' = 0
CHandle == /\ owned /\ deadline > 0 /\ Handle /\ ExtraUnchanged
CFinish == /\ owned /\ deadline > 0 /\ Finish
           /\ deadline' = 0 /\ cleanup' = 0 /\ owned' = FALSE
           /\ occupation' = 0
CAckError == /\ AckError /\ deadline' = 0 /\ cleanup' = 0
             /\ owned' = FALSE /\ occupation' = 0
CRefill == Refill /\ ExtraUnchanged

(* Renewal changes only the live lease, never the execution deadline. The
   runtime's conditional UPDATE additionally fences the physical receipt. *)
Renew == /\ active # 0 /\ owned /\ deadline > 0
         /\ phase # "cancelling" /\ lease[active] > 0
         /\ lease' = [lease EXCEPT ![active] = LeaseTicks]
         /\ UNCHANGED <<rows, attempts, delay, selected, active, phase,
                        done, failed, clock>>
         /\ ExtraUnchanged

LoseOwnership == /\ active # 0 /\ owned
                 /\ owned' = FALSE /\ phase' = "cancelling"
                 /\ cleanup' = GraceTicks
                 /\ UNCHANGED <<rows, attempts, delay, lease, selected,
                                active, done, failed, clock, deadline,
                                occupation>>

CTick ==
    /\ delay' = [j \in Jobs |-> IF delay[j] > 0 THEN delay[j] - 1 ELSE 0]
    /\ clock' = 1 - clock
    /\ UNCHANGED <<rows, attempts, selected, done, failed>>
    /\ IF active = 0
       THEN /\ lease' = [j \in Jobs |-> IF lease[j] > 0 THEN lease[j] - 1 ELSE 0]
            /\ UNCHANGED <<active, phase, deadline, cleanup, owned, occupation>>
       ELSE IF phase = "cancelling" /\ cleanup = 1
       THEN (* Cooperative stop plus bounded conditional release. No attempt
               reset; exhausted rows keep the existing terminal convention. *)
            /\ lease' = [j \in Jobs |-> IF j = active THEN 0
                         ELSE IF lease[j] > 0 THEN lease[j] - 1 ELSE 0]
            /\ active' = 0 /\ phase' = "idle" /\ owned' = FALSE
            /\ deadline' = 0 /\ cleanup' = 0 /\ occupation' = 0
       ELSE /\ lease' = [j \in Jobs |-> IF lease[j] > 0 THEN lease[j] - 1 ELSE 0]
            /\ occupation' = occupation + 1
            /\ active' = active
            /\ IF phase = "cancelling"
               THEN /\ cleanup' = cleanup - 1
                    /\ UNCHANGED <<phase, deadline, owned>>
               ELSE /\ deadline' = deadline - 1
                    /\ IF deadline = 1 \/ lease[active] = 1
                       THEN /\ phase' = "cancelling" /\ owned' = FALSE
                            /\ cleanup' = GraceTicks
                       ELSE /\ UNCHANGED <<phase, owned, cleanup>>

CNext == CSelect \/ CClaim \/ CHandle \/ CFinish \/ CAckError
         \/ CRefill \/ Renew \/ LoseOwnership \/ CTick
CSpec == CInit /\ [][CNext]_cvars
         /\ WF_cvars(CSelect) /\ WF_cvars(CClaim) /\ WF_cvars(CHandle)
         /\ WF_cvars(CFinish) /\ WF_cvars(CRefill) /\ WF_cvars(CTick)

CTypeOK == /\ phase \in {"idle", "running", "ack", "retry", "terminal", "hung", "cancelling"}
           /\ attempts \in [Jobs -> 0..MaxAttempts]
           /\ lease \in [Jobs -> 0..LeaseTicks]
           /\ deadline \in 0..ExecutionTicks /\ cleanup \in 0..GraceTicks
           /\ owned \in BOOLEAN
           /\ (phase = "idle") = (active = 0)
           /\ (owned => active # 0 /\ lease[active] > 0 /\ deadline > 0)
BoundedCooperativeOccupation == occupation <= ExecutionTicks + GraceTicks
CooperativeCapacityRecovery == [](active # 0 => <>(active = 0))
=============================================================================
