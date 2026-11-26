----------------------------- MODULE Lifecycle -----------------------------
EXTENDS Naturals, FiniteSets

(* Consumer extraction: claimNextLocalJob, processClaimedJob,
   createSingleQueuePoller, SqliteQueueServiceLive. The initial rows have
   already committed; Enqueue.tla checks the producer/reporting boundary.

   Numeric job ranks encode (availableAt, id) ordering. Recycled jobs denote
   an unbounded stream of NEW physical IDs, all newer than the observed job.
   Only Observed jobs have identity-sensitive temporal properties. Without
   this quotient, a finite producer model would miss starvation entirely.

   One local worker, GLOBAL_MAX_CONCURRENT = 1. No concurrent external queue
   mutation or second worker is modeled; receipt fencing is outside scope.
   SELECT and conditional UPDATE are separate actions, so an arrival between
   them does not change the selected ID. *)

CONSTANTS Jobs, MaxAttempts, LeaseTicks, DelayTicks, Supported,
          Recycled, Observed, InitialAttempts, NewestFirst, AttemptsFirst,
          AllowFailure, AllowHang, AllowCrash, AllowAckFailure

ASSUME /\ Jobs \subseteq Nat \ {0}
       /\ MaxAttempts \in Nat
       /\ LeaseTicks \in Nat \ {0}
       /\ DelayTicks \in Nat
       /\ Supported \subseteq Jobs
       /\ Recycled \subseteq Jobs
       /\ Observed \subseteq Jobs \ Recycled
       /\ Observed # {}
       /\ InitialAttempts \in [Jobs -> 0..MaxAttempts]
       /\ \A r \in Recycled : \A j \in Observed : r > j
       /\ {NewestFirst, AttemptsFirst, AllowFailure, AllowHang,
            AllowCrash, AllowAckFailure} \subseteq BOOLEAN

VARIABLES rows, attempts, delay, lease, selected, active, phase,
          done, failed, clock

vars == <<rows, attempts, delay, lease, selected, active, phase,
          done, failed, clock>>

ZeroAttempts == [j \in Jobs |-> 0]
(* Used by the retry-starvation and scheduler-comparison cfgs. The observed
   older job (rank 1) starts with one prior attempt; rank 2 represents the
   stream of newer, fresh arrivals with zero prior attempts. *)
RetriedTarget == [j \in Jobs |-> IF j = 1 THEN 1 ELSE 0]

Init ==
    /\ rows = Jobs
    /\ attempts = InitialAttempts
    /\ delay = [j \in Jobs |-> DelayTicks]
    /\ lease = [j \in Jobs |-> 0]
    /\ selected = 0
    /\ active = 0
    /\ phase = "idle"
    /\ done = {}
    /\ failed = {}
    /\ clock = 0

Eligible == {j \in rows \cap Supported :
    delay[j] = 0 /\ lease[j] = 0 /\ attempts[j] < MaxAttempts}

Earlier(i, j) == IF NewestFirst THEN i > j ELSE i < j
Before(i, j) ==
    IF AttemptsFirst
    THEN attempts[i] < attempts[j]
         \/ (attempts[i] = attempts[j] /\ Earlier(i, j))
    ELSE Earlier(i, j)

Select ==
    /\ phase = "idle"
    /\ selected = 0
    /\ Eligible # {}
    /\ \E j \in Eligible :
         /\ \A k \in Eligible \ {j} : Before(j, k)
         /\ selected' = j
    /\ UNCHANGED <<rows, attempts, delay, lease, active, phase,
                   done, failed, clock>>

Claim ==
    /\ selected \in Eligible
    /\ phase = "idle"
    /\ active' = selected
    /\ phase' = "running"
    /\ attempts' = [attempts EXCEPT ![selected] = @ + 1]
    /\ lease' = [lease EXCEPT ![selected] = LeaseTicks]
    /\ selected' = 0
    /\ UNCHANGED <<rows, delay, done, failed, clock>>

(* The generic runtime imposes no handler deadline. Hang represents an
   unresolved external call/Effect.never, not merely slow but finite work. *)
Handle ==
    /\ phase = "running"
    /\ \E result \in
         {"ack"} \cup (IF AllowFailure THEN {"retry", "terminal"} ELSE {})
                 \cup (IF AllowHang THEN {"hung"} ELSE {}) :
         phase' = result
    /\ UNCHANGED <<rows, attempts, delay, lease, selected, active,
                   done, failed, clock>>

(* The finalizer releases the semaphore only after handling/acknowledgement.
   Retry includes defects, ScheduledFlowNotFoundError and retryable failures;
   all retain the lease. Terminal fail retains the row with attempts=limit. *)
Finish ==
    /\ phase \in {"ack", "retry", "terminal"}
    /\ IF phase = "ack"
       THEN /\ rows' = rows \ {active}
            /\ done' = done \cup {active}
            /\ UNCHANGED <<attempts, lease, failed>>
       ELSE IF phase = "terminal"
       THEN /\ attempts' = [attempts EXCEPT ![active] = MaxAttempts]
            /\ lease' = [lease EXCEPT ![active] = 0]
            /\ failed' = failed \cup {active}
            /\ UNCHANGED <<rows, done>>
       ELSE UNCHANGED <<rows, done, attempts, lease, failed>>
    /\ active' = 0
    /\ phase' = "idle"
    /\ UNCHANGED <<delay, selected, clock>>

AckError ==
    /\ AllowAckFailure
    /\ phase = "ack"
    /\ active' = 0
    /\ phase' = "idle"
    /\ UNCHANGED <<rows, attempts, delay, lease, selected, done, failed, clock>>

(* Abandon an already-claimed attempt and restart. Persistent row/attempt/
   lease survive; the volatile semaphore/handler do not. Restarts endlessly
   before claiming are excluded by the progress assumptions, not solved. *)
Crash ==
    /\ AllowCrash
    /\ active # 0
    /\ active' = 0
    /\ phase' = "idle"
    /\ UNCHANGED <<rows, attempts, delay, lease, selected, done, failed, clock>>

Tick ==
    /\ delay' = [j \in Jobs |-> IF delay[j] > 0 THEN delay[j] - 1 ELSE 0]
    /\ lease' = [j \in Jobs |-> IF lease[j] > 0 THEN lease[j] - 1 ELSE 0]
    /\ clock' = 1 - clock
    /\ UNCHANGED <<rows, attempts, selected, active, phase, done, failed>>

Refill ==
    /\ \E j \in Recycled \cap done :
         /\ rows' = rows \cup {j}
         /\ attempts' = [attempts EXCEPT ![j] = 0]
         /\ delay' = [delay EXCEPT ![j] = 0]
         /\ lease' = [lease EXCEPT ![j] = 0]
         /\ done' = done \ {j}
         /\ failed' = failed \ {j}
    /\ UNCHANGED <<selected, active, phase, clock>>

Next == Select \/ Claim \/ Handle \/ Finish \/ AckError \/ Crash
        \/ Tick \/ Refill

(* Aggregate fairness makes the polling loop run; it does NOT make each job
   win the deterministic priority query. Fairness on Claim(j) would conceal
   the scheduling bug. Time advances even with an occupied semaphore. *)
Spec == Init /\ [][Next]_vars
        /\ WF_vars(Select) /\ WF_vars(Claim) /\ WF_vars(Handle)
        /\ WF_vars(Finish) /\ WF_vars(Tick) /\ WF_vars(Refill)

TypeOK ==
    /\ rows \subseteq Jobs
    /\ attempts \in [Jobs -> 0..MaxAttempts]
    /\ delay \in [Jobs -> 0..DelayTicks]
    /\ lease \in [Jobs -> 0..LeaseTicks]
    /\ selected \in Jobs \cup {0}
    /\ active \in Jobs \cup {0}
    /\ phase \in {"idle", "running", "ack", "retry", "terminal", "hung"}
    /\ done \subseteq Jobs
    /\ failed \subseteq rows
    /\ clock \in {0, 1}
    /\ (phase = "idle") = (active = 0)
    /\ (active # 0 => active \in rows /\ selected = 0)
    /\ (selected # 0 => selected \in Eligible)
    /\ rows \cap done = {}

NoLostAcceptedWork == Jobs = rows \cup done

(* "Settled" includes retained, exhausted dead letters, not just success.
   Unlike getStats, do not call an active final attempt settled. *)
Settled(j) == j \in done \/
    (j \in rows /\ attempts[j] = MaxAttempts /\ lease[j] = 0 /\ active # j)

EventuallyAttempted == \A j \in Observed : <>(attempts[j] > 0)
EventuallySettled == \A j \in Observed : <>Settled(j)
EventuallyRemoved == \A j \in Observed : <>(j \notin rows)
EventuallyRecordedOutcome == \A j \in Observed : <>(j \in done \cup failed)

=============================================================================
