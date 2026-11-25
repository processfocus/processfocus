----------------------------- MODULE Terminal -----------------------------
EXTENDS Cooperative

(* Refinement for #3669. rows denotes ACTIVE work, not physical retention.
   Evidence and retirement are one conditional DB UPDATE. Failed SQL / rollback
   is stuttering: neither half can become durable alone. Receipt fencing and
   writer-before-clock sampling implement the atomic lease guard here.
   Recycled ranks still represent fresh physical IDs, not automatic redrive. *)
VARIABLE evidence
tvars == <<cvars, evidence>>
TInit == CInit /\ evidence = [j \in Jobs |-> "none"]
TSelect == CSelect /\ UNCHANGED evidence
TClaim == CClaim /\ UNCHANGED evidence
THandle == CHandle /\ UNCHANGED evidence
TTick == CTick /\ UNCHANGED evidence
TRenew == Renew /\ UNCHANGED evidence
TLose == LoseOwnership /\ UNCHANGED evidence
TAckError == CAckError /\ UNCHANGED evidence
TRefill == CRefill /\ UNCHANGED evidence
TCrash == Crash /\ deadline' = 0 /\ cleanup' = 0 /\ owned' = FALSE
          /\ occupation' = 0 /\ UNCHANGED evidence

TFinish ==
    /\ owned /\ deadline > 0 /\ lease[active] > 0
    /\ phase \in {"ack", "retry", "terminal"}
    /\ IF phase = "ack"
       THEN /\ rows' = rows \ {active} /\ done' = done \cup {active}
            /\ UNCHANGED <<failed, evidence, lease>>
       ELSE IF phase = "terminal" \/ attempts[active] = MaxAttempts
       THEN /\ rows' = rows \ {active} /\ failed' = failed \cup {active}
            /\ evidence' = [evidence EXCEPT ![active] = "handler-failure"]
            /\ lease' = [lease EXCEPT ![active] = 0]
            /\ UNCHANGED done
       ELSE UNCHANGED <<rows, done, failed, evidence, lease>>
    /\ active' = 0 /\ phase' = "idle" /\ owned' = FALSE
    /\ deadline' = 0 /\ cleanup' = 0 /\ occupation' = 0
    /\ UNCHANGED <<attempts, delay, selected, clock>>

(* Set-based maintenance, not per-job selection fairness, can retire every
   exhausted expired row even when the processing slot is occupied. Remaining
   budget is already retry-eligible after lease expiry; no reset is needed. *)
Recoverable == {j \in rows : attempts[j] = MaxAttempts /\ lease[j] = 0}
Maintain ==
    /\ Recoverable # {}
    /\ rows' = rows \ Recoverable /\ failed' = failed \cup Recoverable
    /\ evidence' = [j \in Jobs |-> IF j \in Recoverable THEN "unknown" ELSE evidence[j]]
    /\ UNCHANGED <<attempts, delay, lease, selected, active, phase, done, clock,
                   deadline, cleanup, owned, occupation>>

TNext == TSelect \/ TClaim \/ THandle \/ TFinish \/ TAckError \/ TCrash
         \/ TTick \/ TRenew \/ TLose \/ TRefill \/ Maintain
TSpec == TInit /\ [][TNext]_tvars
         /\ WF_tvars(TSelect) /\ WF_tvars(TClaim) /\ WF_tvars(THandle)
         /\ WF_tvars(TFinish) /\ WF_tvars(TTick) /\ WF_tvars(TRefill)
         /\ WF_tvars(Maintain)

TerminalTypeOK == CTypeOK /\ rows \subseteq Jobs /\ done \subseteq Jobs
                  /\ failed \subseteq Jobs
                  /\ evidence \in [Jobs -> {"none", "handler-failure", "unknown"}]
Accounted == Jobs = rows \cup done \cup failed
AtomicRetirement == /\ failed = {j \in Jobs : evidence[j] # "none"}
                    /\ rows \cap failed = {} /\ rows \cap done = {}
                    /\ done \cap failed = {}
LiveFinalProtected == owned /\ active # 0 => active \notin failed
FinalRecovery == \A j \in Observed :
    [](j \in rows /\ attempts[j] = MaxAttempts /\ lease[j] = 0 => <>(j \in failed))
RecordedOutcomes == \A j \in Observed : <>(j \in done \cup failed)
=============================================================================
